import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildDefinitionGraph,
  createSymbolNodeId,
  deserializeProjectAnalysis,
  loadProjectAnalysis,
  parseSourceFile,
  saveProjectAnalysis,
  serializeProjectAnalysis,
  type ProjectAnalysis,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JSON persistence", () => {
  function createAnalysis(): ProjectAnalysis {
    const graph = buildDefinitionGraph([
      parseSourceFile(
        "src/service.ts",
        "export class Service { run() {} }",
      ),
    ]);
    return {
      rootDirectory: "/project",
      graph,
      diagnostics: [],
      fileHashes: { "src/service.ts": "test-hash" },
    };
  }

  it("round-trips nodes, edges, metadata, and query behavior", () => {
    const original = createAnalysis();
    const loaded = deserializeProjectAnalysis(
      serializeProjectAnalysis(original),
    );

    assert.equal(loaded.rootDirectory, "/project");
    assert.deepEqual(loaded.graph.getNodes(), original.graph.getNodes());
    assert.deepEqual(loaded.graph.getEdges(), original.graph.getEdges());
    assert.deepEqual(
      loaded.graph
        .getDependencies(createSymbolNodeId("src/service.ts", "Service"))
        .map((node) => node.id),
      [createSymbolNodeId("src/service.ts", "Service.run")],
    );
  });

  it("writes and loads an index file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codegraph-json-"));
    temporaryDirectories.push(directory);
    const indexPath = path.join(directory, ".codegraph", "index.json");

    await saveProjectAnalysis(createAnalysis(), indexPath);
    const loaded = await loadProjectAnalysis(indexPath);

    assert.equal(loaded.graph.nodeCount, 3);
    assert.match(await readFile(indexPath, "utf8"), /"schemaVersion": 2/);
  });

  it("rejects unsupported schema versions", () => {
    const serialized = serializeProjectAnalysis(createAnalysis()).replace(
      '"schemaVersion": 2',
      '"schemaVersion": 999',
    );

    assert.throws(
      () => deserializeProjectAnalysis(serialized),
      /Unsupported Codegraph schema version: 999/,
    );
  });

  it("rejects malformed JSON", () => {
    assert.throws(
      () => deserializeProjectAnalysis("{not-json"),
      /Invalid Codegraph JSON/,
    );
  });
});
