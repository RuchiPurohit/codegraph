import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildDefinitionGraph,
  createVisualizationDocument,
  parseSourceFile,
  startVisualizationServer,
  writeVisualizationDocument,
  type ProjectAnalysis,
} from "../src/index.js";

function createAnalysis(): ProjectAnalysis {
  return {
    rootDirectory: "/example/project",
    graph: buildDefinitionGraph([
      parseSourceFile("src/service.ts", "export class Service { run() {} }"),
    ]),
    diagnostics: [],
    fileHashes: {},
  };
}

describe("graph visualization", () => {
  it("embeds graph data and interactive controls in a standalone document", () => {
    const document = createVisualizationDocument(createAnalysis());
    assert.match(document, /Interactive code graph/);
    assert.match(document, /src\/service\.ts/);
    assert.match(document, /data-edge="CALLS"/);
    assert.match(document, /Search files and symbols/);
    assert.match(document, /Ask: What calls analyzeProject/);
    assert.match(document, /function askQuestion\(\)/);
    assert.match(document, /Incoming.*relationships/);
    assert.ok(document.includes("split(/\\s+/)"));
    assert.match(document, /vscode:\/\/file/);
    assert.match(document, /Open matched source/);
    assert.ok(document.includes("replace(/\\/$/"));
    assert.match(document, /Hover a node to reveal its label/);
    assert.match(document, /const showLabel = node => node === hovered/);
    assert.match(document, /context\.fillText\(text,x,y\)/);
    assert.match(document, /Node color legend/);
    assert.match(document, /#4cc9f0.*File/);
    assert.match(document, /#c77dff.*Method/);
    assert.match(document, /dx \/ distance \* force/);
    assert.doesNotMatch(document, /https?:\/\/[^<]*\.(js|css)/);
  });

  it("serves the visualization only on the local HTTP endpoint", async (context) => {
    const openedUris: string[] = [];
    let visualization;
    try {
      visualization = await startVisualizationServer(createAnalysis(), {
        openBrowser: false,
        openSource: (uri) => { openedUris.push(uri); },
      });
    } catch (error: unknown) {
      if (isPermissionError(error)) {
        context.skip("The execution sandbox does not permit binding a local port");
        return;
      }
      throw error;
    }
    try {
      assert.match(visualization.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      const response = await fetch(visualization.url);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await response.text(), /Codegraph/);
      const openResponse = await fetch(`${visualization.url}open?node=${encodeURIComponent("symbol:src%2Fservice.ts:Service.run")}`);
      assert.equal(openResponse.status, 204);
      assert.deepEqual(openedUris, ["vscode://file/project/src/service.ts:1:32"]);
      assert.equal((await fetch(`${visualization.url}missing`)).status, 404);
    } finally {
      await visualization.close();
    }
  });

  it("writes a self-contained HTML file and creates parent directories", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codegraph-viewer-"));
    try {
      const outputPath = path.join(directory, "nested", "visualization.html");
      assert.equal(
        await writeVisualizationDocument(createAnalysis(), outputPath),
        outputPath,
      );
      const document = await readFile(outputPath, "utf8");
      assert.match(document, /Interactive code graph/);
      assert.match(document, /src\/service\.ts/);
      assert.doesNotMatch(document, /<script[^>]+src=/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}
