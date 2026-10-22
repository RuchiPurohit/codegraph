import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createCodeGraphMcpServer } from "../src/mcp/server.js";

const execFileAsync = promisify(execFile);

describe("CodeGraph MCP server", () => {
  let root: string;
  let server: McpServer;
  let client: Client;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codeskope-mcp-"));
    await writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
      }),
    );
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
      "src/controller.ts",
      [
        'import { AuthService } from "./service.js";',
        "export class AuthController {",
        "  constructor(private service: AuthService) {}",
        "  login() { return this.service.login(); }",
        "}",
      ].join("\n"),
    );
    await writeFixture(
      "src/app.ts",
      [
        'import { AuthController } from "./controller.js";',
        "export class App {",
        "  constructor(private controller: AuthController) {}",
        "  start() { return this.controller.login(); }",
        "}",
      ].join("\n"),
    );

    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=CodeGraph Test",
        "-c",
        "user.email=codeskope@example.test",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );

    server = createCodeGraphMcpServer({ rootDirectory: root });
    client = new Client(
      { name: "codeskope-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixture(
    relativePath: string,
    contents: string,
  ): Promise<void> {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }

  it("advertises a small, annotated, structured tool surface", async () => {
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      [
        "find_symbol",
        "get_dependencies",
        "get_dependents",
        "find_path",
        "analyze_impact",
        "analyze_diff",
        "refresh_index",
      ],
    );
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.outputSchema?.type, "object");
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
    assert.equal(
      result.tools.find((tool) => tool.name === "refresh_index")
        ?.annotations?.readOnlyHint,
      false,
    );
  });

  it("returns source-linked symbols, relationships, paths, and impact", async () => {
    const service = await callStructured("find_symbol", {
      query: "AuthService.login",
    });
    const serviceMatches = arrayOfRecords(service.matches);
    assert.equal(serviceMatches.length, 1);
    assert.equal(serviceMatches[0]?.qualifiedName, "AuthService.login");
    assert.equal(record(serviceMatches[0]?.source).path, "src/service.ts");
    const serviceId = stringValue(serviceMatches[0]?.id);

    const controller = await callStructured("find_symbol", {
      query: "AuthController.login",
    });
    const controllerId = stringValue(arrayOfRecords(controller.matches)[0]?.id);
    const dependencies = await callStructured("get_dependencies", {
      nodeId: controllerId,
      relationships: ["CALLS"],
    });
    const dependencyRelationships = arrayOfRecords(dependencies.relationships);
    assert.equal(
      record(dependencyRelationships[0]?.entity).qualifiedName,
      "AuthService.login",
    );
    assert.equal(
      record(dependencyRelationships[0]?.relationship).provenance,
      "typescript-type-checker",
    );

    const dependents = await callStructured("get_dependents", {
      nodeId: serviceId,
      relationships: ["CALLS"],
    });
    assert.equal(
      record(arrayOfRecords(dependents.relationships)[0]?.entity).qualifiedName,
      "AuthController.login",
    );

    const app = await callStructured("find_symbol", { query: "App.start" });
    const appId = stringValue(arrayOfRecords(app.matches)[0]?.id);
    const pathResult = await callStructured("find_path", {
      fromNodeId: appId,
      toNodeId: serviceId,
      relationships: ["CALLS"],
    });
    assert.equal(pathResult.found, true);
    assert.equal(pathResult.edgeCount, 2);
    assert.deepEqual(
      arrayOfRecords(pathResult.path).map(
        (entry) => record(entry.entity).qualifiedName,
      ),
      ["App.start", "AuthController.login", "AuthService.login"],
    );

    const impact = await callStructured("analyze_impact", {
      nodeId: serviceId,
      relationships: ["CALLS"],
      maxDepth: 5,
    });
    assert.deepEqual(
      arrayOfRecords(impact.directDependents).map(
        (entry) => entry.qualifiedName,
      ),
      ["AuthController.login"],
    );
    assert.deepEqual(
      arrayOfRecords(impact.indirectDependents).map(
        (entry) => entry.qualifiedName,
      ),
      ["App.start"],
    );
  });

  it("refreshes after edits and maps the Git diff to affected symbols", async () => {
    const initialRefresh = await callStructured("refresh_index", {
      mode: "full",
    });
    assert.equal(record(initialRefresh.graph).fileCount, 3);

    await writeFixture(
      "src/service.ts",
      [
        "export class AuthService {",
        "  login() {",
        "    return false;",
        "  }",
        "}",
      ].join("\n"),
    );

    const refresh = await callStructured("refresh_index", {
      mode: "incremental",
    });
    assert.deepEqual(record(refresh.files).changed, ["src/service.ts"]);
    assert.deepEqual(
      record(refresh.files).affected,
      ["src/app.ts", "src/controller.ts", "src/service.ts"],
    );

    const diff = await callStructured("analyze_diff", {
      relationships: ["CALLS"],
      maxDepth: 5,
    });
    assert.deepEqual(
      arrayOfRecords(diff.changedSymbols).map(
        (entry) => entry.qualifiedName,
      ),
      ["AuthService.login"],
    );
    const firstImpact = arrayOfRecords(diff.impacts)[0];
    assert.equal(record(firstImpact?.counts).direct, 1);
    assert.equal(record(firstImpact?.counts).indirect, 1);
  });

  it("reports invalid node IDs as MCP tool errors", async () => {
    const result = await client.callTool({
      name: "get_dependencies",
      arguments: { nodeId: "symbol:missing" },
    });
    assert.equal("isError" in result && result.isError, true);
    assert.match(JSON.stringify(result), /Node does not exist/);
  });

  async function callStructured(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.equal("isError" in result && result.isError, false);
    assert.ok("structuredContent" in result);
    return record(result.structuredContent);
  }
});

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected a string value");
  }
  return value;
}
