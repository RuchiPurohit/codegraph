import { execFile } from "node:child_process";
import type { CodeGraph, SymbolNodeData } from "../analyzer/buildDefinitionGraph.js";
import type { GraphNode } from "../graph/types.js";
import { analyzeImpact, type ImpactOptions, type ImpactResult } from "../queries/analyzeImpact.js";

export interface ChangedFileLines {
  readonly filePath: string;
  readonly lines: readonly number[];
}

export interface UnmappedChangedLine {
  readonly filePath: string;
  readonly line: number;
}

export interface DiffImpactResult {
  readonly changes: readonly ChangedFileLines[];
  readonly changedSymbols: readonly GraphNode<SymbolNodeData>[];
  readonly impacts: readonly ImpactResult[];
  readonly unmappedLines: readonly UnmappedChangedLine[];
}

/** Reads staged and unstaged tracked changes relative to HEAD. */
export function readGitDiff(rootDirectory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--unified=0", "--no-color", "HEAD", "--"],
      { cwd: rootDirectory, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function parseGitDiff(diffText: string): readonly ChangedFileLines[] {
  const changedLinesByFile = new Map<string, Set<number>>();
  let currentFile: string | null = null;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const pathText = line.slice(4);
      currentFile = pathText === "/dev/null"
        ? null
        : pathText.startsWith("b/")
          ? pathText.slice(2)
          : pathText;
      if (currentFile !== null && !isTypeScriptSourcePath(currentFile)) {
        currentFile = null;
      }
      continue;
    }

    if (currentFile === null || !line.startsWith("@@")) {
      continue;
    }

    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) {
      continue;
    }
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    let fileLines = changedLinesByFile.get(currentFile);
    if (fileLines === undefined) {
      fileLines = new Set<number>();
      changedLinesByFile.set(currentFile, fileLines);
    }
    for (let offset = 0; offset < count; offset += 1) {
      fileLines.add(start + offset);
    }
  }

  return [...changedLinesByFile]
    .map(([filePath, lines]) => ({
      filePath,
      lines: [...lines].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function isTypeScriptSourcePath(filePath: string): boolean {
  return !filePath.endsWith(".d.ts") &&
    (filePath.endsWith(".ts") || filePath.endsWith(".tsx"));
}

export function analyzeDiffImpact(
  graph: CodeGraph,
  diffText: string,
  impactOptions: ImpactOptions = {},
): DiffImpactResult {
  const changes = parseGitDiff(diffText);
  const symbolsByFile = indexSymbolsByFile(graph);
  const changedSymbolIds = new Set<string>();
  const unmappedLines: UnmappedChangedLine[] = [];

  for (const change of changes) {
    const candidates = symbolsByFile.get(change.filePath) ?? [];
    for (const line of change.lines) {
      const containing = candidates
        .filter(
          (node) =>
            node.data.range.startLine <= line && node.data.range.endLine >= line,
        )
        .sort(compareInnermostFirst);
      const symbol = containing[0];
      if (symbol === undefined) {
        unmappedLines.push({ filePath: change.filePath, line });
      } else {
        changedSymbolIds.add(symbol.id);
      }
    }
  }

  const changedSymbols = [...changedSymbolIds].map((id) => {
    const node = graph.getNode(id);
    if (node === undefined || node.data.nodeType !== "symbol") {
      throw new Error(`Internal diff mapping invariant failed for symbol: ${id}`);
    }
    return node as GraphNode<SymbolNodeData>;
  });
  const impacts = changedSymbols.map((node) =>
    analyzeImpact(graph, node.id, impactOptions),
  );

  return { changes, changedSymbols, impacts, unmappedLines };
}

function indexSymbolsByFile(
  graph: CodeGraph,
): ReadonlyMap<string, readonly GraphNode<SymbolNodeData>[]> {
  const result = new Map<string, GraphNode<SymbolNodeData>[]>();
  for (const node of graph.getNodes()) {
    if (node.data.nodeType !== "symbol") {
      continue;
    }
    let symbols = result.get(node.data.range.file);
    if (symbols === undefined) {
      symbols = [];
      result.set(node.data.range.file, symbols);
    }
    symbols.push(node as GraphNode<SymbolNodeData>);
  }
  return result;
}

function compareInnermostFirst(
  left: GraphNode<SymbolNodeData>,
  right: GraphNode<SymbolNodeData>,
): number {
  const leftSpan = left.data.range.endLine - left.data.range.startLine;
  const rightSpan = right.data.range.endLine - right.data.range.startLine;
  if (leftSpan !== rightSpan) {
    return leftSpan - rightSpan;
  }
  return right.data.qualifiedName.length - left.data.qualifiedName.length;
}
