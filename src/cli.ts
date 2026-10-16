#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeDiffImpact,
  analyzeImpact,
  analyzeProject,
  defaultIndexPath,
  findCodePath,
  findSymbols,
  getCodeDependencies,
  getCodeDependents,
  loadProjectAnalysis,
  readGitDiff,
  saveProjectAnalysis,
  updateProjectIndex,
  type CodeGraph,
  type CodeGraphNodeData,
  type GraphNode,
} from "./index.js";

export async function runCli(arguments_: readonly string[]): Promise<number> {
  const options = parseOptions(arguments_);
  const [command, ...operands] = options.operands;
  if (command === undefined || command === "help" || command === "--help") {
    printUsage();
    return 0;
  }

  const effectiveRoot = command === "index" && operands[0] !== undefined
    ? operands[0]
    : options.rootDirectory;
  if (command === "update") {
    const updateRoot = operands[0] ?? options.rootDirectory;
    const indexPath = options.graphFile ?? defaultIndexPath(updateRoot);
    const result = await updateProjectIndex(indexPath, updateRoot);
    console.log(`Added files: ${result.files.added.length}`);
    console.log(`Changed files: ${result.files.changed.length}`);
    console.log(`Deleted files: ${result.files.deleted.length}`);
    console.log(`Affected files: ${result.files.affected.length}`);
    console.log(`Reused files: ${result.files.reused.length}`);
    console.log(`Saved: ${path.resolve(indexPath)}`);
    return 0;
  }
  const analysis = command !== "index" && options.graphFile !== undefined
    ? await loadProjectAnalysis(options.graphFile)
    : await analyzeProject(effectiveRoot);
  const graph = analysis.graph;

  switch (command) {
    case "index": {
      const outputPath = options.outputFile ?? defaultIndexPath(
        analysis.rootDirectory,
      );
      await saveProjectAnalysis(analysis, outputPath);
      const edgeCounts = new Map<string, number>();
      for (const edge of graph.getEdges()) {
        edgeCounts.set(edge.type, (edgeCounts.get(edge.type) ?? 0) + 1);
      }
      console.log(`Files: ${graph.getNodes().filter((node) => node.data.nodeType === "file").length}`);
      console.log(`Symbols: ${graph.getNodes().filter((node) => node.data.nodeType === "symbol").length}`);
      console.log(`Edges: ${graph.edgeCount}`);
      for (const [type, count] of edgeCounts) {
        console.log(`  ${type}: ${count}`);
      }
      console.log(`Diagnostics: ${analysis.diagnostics.length}`);
      const diagnosticCounts = new Map<string, number>();
      for (const diagnostic of analysis.diagnostics) {
        diagnosticCounts.set(
          diagnostic.kind,
          (diagnosticCounts.get(diagnostic.kind) ?? 0) + 1,
        );
      }
      for (const [kind, count] of diagnosticCounts) {
        console.log(`  ${kind}: ${count}`);
      }
      console.log(`Saved: ${path.resolve(outputPath)}`);
      return 0;
    }

    case "find": {
      const query = requiredOperand(operands[0], "find requires a symbol query");
      for (const node of findSymbols(graph, query)) {
        console.log(formatNode(node));
      }
      return 0;
    }

    case "deps": {
      const node = resolveOne(graph, requiredOperand(operands[0], "deps requires a symbol"));
      const relationships = node.data.nodeType === "file" ? ["IMPORTS"] as const : ["CALLS"] as const;
      for (const dependency of getCodeDependencies(graph, node.id, relationships)) {
        console.log(formatNode(dependency));
      }
      return 0;
    }

    case "dependents": {
      const node = resolveOne(
        graph,
        requiredOperand(operands[0], "dependents requires a symbol"),
      );
      const relationships = node.data.nodeType === "file" ? ["IMPORTS"] as const : ["CALLS"] as const;
      for (const dependent of getCodeDependents(graph, node.id, relationships)) {
        console.log(formatNode(dependent));
      }
      return 0;
    }

    case "path": {
      const source = resolveOne(graph, requiredOperand(operands[0], "path requires a source"));
      const target = resolveOne(graph, requiredOperand(operands[1], "path requires a target"));
      const result = findCodePath(graph, source.id, target.id);
      if (result === null) {
        console.log("No dependency path found.");
        return 1;
      }
      for (const id of result) {
        const node = graph.getNode(id);
        if (node !== undefined) {
          console.log(formatNode(node));
        }
      }
      return 0;
    }

    case "impact": {
      const node = resolveOne(graph, requiredOperand(operands[0], "impact requires a symbol"));
      printImpact(analyzeImpact(graph, node.id));
      return 0;
    }

    case "diff": {
      const diff = await readGitDiff(analysis.rootDirectory);
      const result = analyzeDiffImpact(graph, diff);
      if (result.changedSymbols.length === 0) {
        console.log("No changed symbols found in tracked TypeScript changes.");
      }
      for (const [index, changed] of result.changedSymbols.entries()) {
        console.log(index === 0 ? "Changed symbols:" : "");
        console.log(`- ${formatNode(changed)}`);
      }
      for (const impact of result.impacts) {
        printImpact(impact);
      }
      if (result.unmappedLines.length > 0) {
        console.log("Unmapped changed lines:");
        for (const line of result.unmappedLines) {
          console.log(`- ${line.filePath}:${line.line}`);
        }
      }
      return 0;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function parseOptions(arguments_: readonly string[]): {
  readonly operands: readonly string[];
  readonly rootDirectory: string;
  readonly graphFile: string | undefined;
  readonly outputFile: string | undefined;
} {
  const result = [...arguments_];
  const rootDirectory = takeOption(result, "--root") ?? process.cwd();
  const graphFile = takeOption(result, "--graph");
  const outputFile = takeOption(result, "--output");
  return { operands: result, rootDirectory, graphFile, outputFile };
}

function takeOption(arguments_: string[], option: string): string | undefined {
  const index = arguments_.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = arguments_[index + 1];
  if (value === undefined) {
    throw new Error(`${option} requires a value`);
  }
  arguments_.splice(index, 2);
  return value;
}

function resolveOne(
  graph: CodeGraph,
  query: string,
): GraphNode<CodeGraphNodeData> {
  const byId = graph.getNode(query);
  if (byId !== undefined) {
    return byId;
  }
  const fileMatch = graph
    .getNodes()
    .find(
      (node) => node.data.nodeType === "file" && node.data.filePath === query,
    );
  if (fileMatch !== undefined) {
    return fileMatch;
  }
  const matches = findSymbols(graph, query);
  const exact = matches.filter(
    (node) => node.data.qualifiedName === query || node.data.name === query,
  );
  const candidates = exact.length > 0 ? exact : matches;
  if (candidates.length === 0) {
    throw new Error(`No symbol matches: ${query}`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Symbol is ambiguous: ${query}\n${candidates.map((node) => `- ${formatNode(node)}`).join("\n")}`,
    );
  }
  const match = candidates[0];
  if (match === undefined) {
    throw new Error(`No symbol matches: ${query}`);
  }
  return match;
}

function requiredOperand(value: string | undefined, message: string): string {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function formatNode(node: GraphNode<CodeGraphNodeData>): string {
  if (node.data.nodeType === "file") {
    return node.data.filePath;
  }
  return `${node.data.qualifiedName} (${node.data.location.file}:${node.data.location.line}:${node.data.location.column})`;
}

function printImpact(result: ReturnType<typeof analyzeImpact>): void {
  console.log(`Changed: ${formatNode(result.changed)}`);
  console.log("Direct dependents:");
  for (const node of result.directDependents) {
    console.log(`- ${formatNode(node)}`);
  }
  console.log("Indirect dependents:");
  for (const node of result.indirectDependents) {
    console.log(`- ${formatNode(node)}`);
  }
  console.log("Potentially affected files:");
  for (const file of result.affectedFiles) {
    console.log(`- ${file}`);
  }
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  codegraph index [root] [--output <file>]",
    "  codegraph update [root] [--graph <file>]",
    "  codegraph find <query> [--root <directory> | --graph <file>]",
    "  codegraph deps <symbol> [--root <directory> | --graph <file>]",
    "  codegraph dependents <symbol> [--root <directory> | --graph <file>]",
    "  codegraph path <source> <target> [--root <directory> | --graph <file>]",
    "  codegraph impact <symbol> [--root <directory> | --graph <file>]",
    "  codegraph diff [--root <directory> | --graph <file>]",
  ].join("\n"));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
