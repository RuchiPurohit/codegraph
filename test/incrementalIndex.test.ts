import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  analyzeProject,
  createSymbolNodeId,
  loadProjectAnalysis,
  saveProjectAnalysis,
  updateProjectIndex,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("incremental indexing", () => {
  it("replaces changed files, refreshes importers, and reuses unrelated files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeskope-incremental-"));
    temporaryDirectories.push(root);
    const indexPath = path.join(root, ".codeskope", "index.json");
    await writeFixture(root, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Node",
        strict: true,
      },
    }));
    await writeFixture(
      root,
      "src/dependency.ts",
      "export function oldName() { return true; }",
    );
    await writeFixture(
      root,
      "src/importer.ts",
      [
        'import { oldName } from "./dependency";',
        "export function run() { return oldName(); }",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/unrelated.ts",
      "export function untouched() { return true; }",
    );
    await saveProjectAnalysis(await analyzeProject(root), indexPath);

    await writeFixture(
      root,
      "src/dependency.ts",
      "export function newName() { return true; }",
    );
    const result = await updateProjectIndex(indexPath, root);

    assert.deepEqual(result.files.added, []);
    assert.deepEqual(result.files.changed, ["src/dependency.ts"]);
    assert.deepEqual(result.files.deleted, []);
    assert.deepEqual(result.files.affected, [
      "src/dependency.ts",
      "src/importer.ts",
    ]);
    assert.deepEqual(result.files.reused, ["src/unrelated.ts"]);
    assert.equal(
      result.analysis.graph.getNode(
        createSymbolNodeId("src/dependency.ts", "oldName"),
      ),
      undefined,
    );
    assert.ok(
      result.analysis.graph.getNode(
        createSymbolNodeId("src/dependency.ts", "newName"),
      ),
    );

    const persisted = await loadProjectAnalysis(indexPath);
    assert.deepEqual(persisted.fileHashes, result.analysis.fileHashes);
    assert.equal(
      persisted.graph.getNode(
        createSymbolNodeId("src/unrelated.ts", "untouched"),
      )?.data.nodeType,
      "symbol",
    );
  });

  it("refreshes an importer when an added file resolves its import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeskope-added-file-"));
    temporaryDirectories.push(root);
    const indexPath = path.join(root, ".codeskope", "index.json");
    await writeFixture(root, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Node",
      },
    }));
    await writeFixture(
      root,
      "src/importer.ts",
      [
        'import { createdLater } from "./created-later";',
        "export function run() { return createdLater(); }",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/unrelated.ts",
      "export function untouched() {}",
    );
    await saveProjectAnalysis(await analyzeProject(root), indexPath);

    await writeFixture(
      root,
      "src/created-later.ts",
      "export function createdLater() { return true; }",
    );
    const result = await updateProjectIndex(indexPath, root);

    assert.deepEqual(result.files.added, ["src/created-later.ts"]);
    assert.deepEqual(result.files.affected, [
      "src/created-later.ts",
      "src/importer.ts",
    ]);
    assert.deepEqual(result.files.reused, ["src/unrelated.ts"]);
    assert.equal(
      result.analysis.graph.hasEdge(
        createSymbolNodeId("src/importer.ts", "run"),
        createSymbolNodeId("src/created-later.ts", "createdLater"),
        "CALLS",
      ),
      true,
    );
  });
});

async function writeFixture(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}
