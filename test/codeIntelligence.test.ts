import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  analyzeDiffImpact,
  analyzeImpact,
  analyzeProject,
  createFileNodeId,
  createSymbolNodeId,
  findCodePath,
  findSymbols,
  getCodeDependencies,
  getCodeDependents,
  parseGitDiff,
  type CodeGraph,
} from "../src/index.js";

describe("code intelligence", () => {
  let root: string;
  let graph: CodeGraph;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codeskope-intelligence-"));
    await writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Node",
        baseUrl: ".",
        paths: { "@domain/*": ["src/domain/*"] },
        strict: true,
      },
    }));
    await writeFixture(
      "src/service.ts",
      [
        "export class AuthService {",
        "  login() {",
        "    return true;",
        "  }",
        "}",
      ].join("\n"),
    );
    await writeFixture(
      "src/validation.ts",
      "export default function validateToken() { return true; }",
    );
    await writeFixture(
      "src/domain/repo.ts",
      "export interface Repo { get(): boolean; }",
    );
    await writeFixture(
      "src/barrel.ts",
      'export { AuthService } from "./service";',
    );
    await writeFixture(
      "src/controller.ts",
      [
        'import { AuthService as Service } from "./service";',
        'import validateToken from "./validation";',
        'import * as services from "./barrel";',
        'import type { Repo } from "@domain/repo";',
        "void services;",
        "export class AuthController {",
        "  constructor(private authService: Service, private repo: Repo) {}",
        "  validate() { return validateToken(); }",
        "  login() {",
        "    this.validate();",
        "    this.authService.login();",
        "    return this.repo.get();",
        "  }",
        "}",
      ].join("\n"),
    );
    await writeFixture(
      "src/app.ts",
      [
        'import { AuthController } from "./controller";',
        "export class App {",
        "  constructor(private controller: AuthController) {}",
        "  start() { return this.controller.login(); }",
        "}",
      ].join("\n"),
    );

    graph = (await analyzeProject(root)).graph;
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixture(relativePath: string, contents: string): Promise<void> {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }

  it("resolves relative, aliased, namespace, and barrel module relationships", () => {
    const controllerId = createFileNodeId("src/controller.ts");
    for (const dependency of [
      "src/service.ts",
      "src/validation.ts",
      "src/barrel.ts",
      "src/domain/repo.ts",
    ]) {
      assert.equal(
        graph.hasEdge(controllerId, createFileNodeId(dependency), "IMPORTS"),
        true,
      );
    }
    assert.equal(
      graph.hasEdge(
        createFileNodeId("src/barrel.ts"),
        createFileNodeId("src/service.ts"),
        "IMPORTS",
      ),
      true,
    );
  });

  it("resolves direct, imported, this, injected, and interface calls", () => {
    const loginId = createSymbolNodeId(
      "src/controller.ts",
      "AuthController.login",
    );
    const dependencies = getCodeDependencies(graph, loginId, ["CALLS"]);
    assert.deepEqual(
      dependencies.map((node) =>
        node.data.nodeType === "symbol" ? node.data.qualifiedName : node.id,
      ),
      ["AuthController.validate", "AuthService.login", "Repo.get"],
    );

    const repoEdge = graph
      .getOutgoingEdges(loginId)
      .find((edge) => edge.to === createSymbolNodeId("src/domain/repo.ts", "Repo.get"));
    assert.equal(repoEdge?.data?.confidence, "inferred");
  });

  it("finds symbols, dependents, and filtered shortest paths", () => {
    const serviceLoginId = createSymbolNodeId("src/service.ts", "AuthService.login");
    const controllerLoginId = createSymbolNodeId(
      "src/controller.ts",
      "AuthController.login",
    );
    const validateTokenId = createSymbolNodeId("src/validation.ts", "validateToken");

    assert.equal(findSymbols(graph, "AuthService")[0]?.data.qualifiedName, "AuthService");
    assert.deepEqual(
      getCodeDependents(graph, serviceLoginId, ["CALLS"]).map((node) => node.id),
      [controllerLoginId],
    );
    assert.deepEqual(findCodePath(graph, controllerLoginId, validateTokenId, ["CALLS"]), [
      controllerLoginId,
      createSymbolNodeId("src/controller.ts", "AuthController.validate"),
      validateTokenId,
    ]);
  });

  it("calculates direct and transitive reverse impact without DEFINES edges", () => {
    const impact = analyzeImpact(
      graph,
      createSymbolNodeId("src/service.ts", "AuthService.login"),
    );

    assert.deepEqual(
      impact.directDependents.map((node) => node.id),
      [createSymbolNodeId("src/controller.ts", "AuthController.login")],
    );
    assert.deepEqual(
      impact.indirectDependents.map((node) => node.id),
      [createSymbolNodeId("src/app.ts", "App.start")],
    );
    assert.deepEqual(impact.affectedFiles, ["src/app.ts", "src/controller.ts"]);
  });

  it("parses changed lines and maps them to the innermost symbol", () => {
    const diff = [
      "diff --git a/src/service.ts b/src/service.ts",
      "--- a/src/service.ts",
      "+++ b/src/service.ts",
      "@@ -3 +3 @@",
      "-    return true;",
      "+    return false;",
    ].join("\n");

    assert.deepEqual(parseGitDiff(diff), [
      { filePath: "src/service.ts", lines: [3] },
    ]);
    const result = analyzeDiffImpact(graph, diff);
    assert.deepEqual(
      result.changedSymbols.map((node) => node.data.qualifiedName),
      ["AuthService.login"],
    );
    assert.deepEqual(
      result.impacts[0]?.directDependents.map((node) => node.id),
      [createSymbolNodeId("src/controller.ts", "AuthController.login")],
    );
    assert.deepEqual(result.unmappedLines, []);
  });
});

describe("call coverage", () => {
  let root: string;
  let analysis: Awaited<ReturnType<typeof analyzeProject>>;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codeskope-coverage-"));
    await writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Node",
        strict: true,
      },
    }));
    await writeFixture(
      "src/helpers.ts",
      [
        "export const seed = async () => 1;",
        "export function plain() { return 1; }",
        "export const typed: () => number = () => 2;",
      ].join("\n"),
    );
    await writeFixture(
      "src/handlers.ts",
      [
        'import { plain, seed, typed } from "./helpers";',
        "export const list = async () => {",
        "  await seed();",
        "  JSON.stringify({});",
        "  return [1].map(() => plain());",
        "};",
        "export class Controller {",
        "  constructor() { plain(); }",
        "  handle = () => typed();",
        "}",
        "plain();",
      ].join("\n"),
    );
    await writeFixture(
      "src/handlers.spec.ts",
      [
        'import { seed } from "./helpers";',
        "declare function it(name: string, run: () => unknown): void;",
        'it("seeds", async () => { await seed(); });',
      ].join("\n"),
    );

    analysis = await analyzeProject(root);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixture(relativePath: string, contents: string): Promise<void> {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }

  function callsFrom(fromId: string): string[] {
    return analysis.graph
      .getOutgoingEdges(fromId)
      .filter((edge) => edge.type === "CALLS")
      .map((edge) => edge.to)
      .sort();
  }

  it("resolves calls from and to functions held by variables", () => {
    assert.deepEqual(callsFrom(createSymbolNodeId("src/handlers.ts", "list")), [
      createSymbolNodeId("src/helpers.ts", "plain"),
      createSymbolNodeId("src/helpers.ts", "seed"),
    ]);
  });

  it("resolves a call through a variable whose signature comes from its type", () => {
    assert.deepEqual(
      callsFrom(createSymbolNodeId("src/handlers.ts", "Controller.handle")),
      [createSymbolNodeId("src/helpers.ts", "typed")],
    );
  });

  it("credits constructors to their class and module-level calls to their file", () => {
    assert.deepEqual(callsFrom(createSymbolNodeId("src/handlers.ts", "Controller")), [
      createSymbolNodeId("src/helpers.ts", "plain"),
    ]);
    assert.deepEqual(callsFrom(createFileNodeId("src/handlers.ts")), [
      createSymbolNodeId("src/helpers.ts", "plain"),
    ]);
    assert.deepEqual(callsFrom(createFileNodeId("src/handlers.spec.ts")), [
      createSymbolNodeId("src/handlers.spec.ts", "it"),
      createSymbolNodeId("src/helpers.ts", "seed"),
    ]);
  });

  it("reports no call diagnostics for resolvable or external calls", () => {
    assert.deepEqual(
      analysis.diagnostics.filter(
        (diagnostic) =>
          diagnostic.kind === "unindexed-target" ||
          diagnostic.kind === "unresolved-call" ||
          diagnostic.kind === "ambiguous-call",
      ),
      [],
    );
  });
});
