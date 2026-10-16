import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AnalysisDiagnostic,
  ProjectAnalysis,
} from "../analyzer/analyzeProject.js";
import type {
  CodeGraphEdgeData,
  CodeGraphEdgeType,
  CodeGraphNodeData,
} from "../analyzer/buildDefinitionGraph.js";
import { DirectedGraph } from "../graph/DirectedGraph.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";

export const CODEGRAPH_JSON_SCHEMA_VERSION = 2;

interface PersistedProjectAnalysis {
  readonly format: "codegraph";
  readonly schemaVersion: typeof CODEGRAPH_JSON_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly rootDirectory: string;
  readonly nodes: readonly GraphNode<CodeGraphNodeData>[];
  readonly edges: readonly GraphEdge<CodeGraphEdgeType, CodeGraphEdgeData>[];
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly fileHashes: Readonly<Record<string, string>>;
}

export function serializeProjectAnalysis(analysis: ProjectAnalysis): string {
  const document: PersistedProjectAnalysis = {
    format: "codegraph",
    schemaVersion: CODEGRAPH_JSON_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    rootDirectory: analysis.rootDirectory,
    nodes: analysis.graph.getNodes(),
    edges: analysis.graph.getEdges(),
    diagnostics: analysis.diagnostics,
    fileHashes: analysis.fileHashes,
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

export function deserializeProjectAnalysis(serialized: string): ProjectAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error: unknown) {
    throw new Error(
      `Invalid Codegraph JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  assertPersistedDocument(parsed);
  const graph = new DirectedGraph<
    CodeGraphNodeData,
    CodeGraphEdgeType,
    CodeGraphEdgeData
  >();

  for (const node of parsed.nodes) {
    graph.addNode(node);
  }
  for (const edge of parsed.edges) {
    graph.addEdge(edge);
  }

  return {
    rootDirectory: parsed.rootDirectory,
    graph,
    diagnostics: parsed.diagnostics,
    fileHashes: parsed.fileHashes,
  };
}

export async function saveProjectAnalysis(
  analysis: ProjectAnalysis,
  outputPath: string,
): Promise<void> {
  const absoluteOutputPath = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  const temporaryPath = `${absoluteOutputPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(temporaryPath, serializeProjectAnalysis(analysis), "utf8");
    await rename(temporaryPath, absoluteOutputPath);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function loadProjectAnalysis(
  inputPath: string,
): Promise<ProjectAnalysis> {
  return deserializeProjectAnalysis(await readFile(inputPath, "utf8"));
}

function assertPersistedDocument(
  value: unknown,
): asserts value is PersistedProjectAnalysis {
  if (!isRecord(value) || value.format !== "codegraph") {
    throw new Error("Invalid Codegraph index: expected format 'codegraph'");
  }
  if (value.schemaVersion !== CODEGRAPH_JSON_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Codegraph schema version: ${String(value.schemaVersion)}`,
    );
  }
  if (typeof value.rootDirectory !== "string") {
    throw new Error("Invalid Codegraph index: rootDirectory must be a string");
  }
  if (!Array.isArray(value.nodes) || !value.nodes.every(isPersistedNode)) {
    throw new Error("Invalid Codegraph index: nodes must contain valid graph nodes");
  }
  if (!Array.isArray(value.edges) || !value.edges.every(isPersistedEdge)) {
    throw new Error("Invalid Codegraph index: edges must contain valid graph edges");
  }
  if (!Array.isArray(value.diagnostics)) {
    throw new Error("Invalid Codegraph index: diagnostics must be an array");
  }
  if (!isStringRecord(value.fileHashes)) {
    throw new Error("Invalid Codegraph index: fileHashes must map paths to hashes");
  }
}

function isPersistedNode(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.data)) {
    return false;
  }
  return value.data.nodeType === "file" || value.data.nodeType === "symbol";
}

function isPersistedEdge(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    (value.type === "DEFINES" || value.type === "IMPORTS" || value.type === "CALLS");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(
    (entry) => typeof entry === "string",
  );
}
