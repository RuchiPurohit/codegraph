#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  analyzeDiffImpact,
  analyzeImpact,
  analyzeProject,
  findCodePath,
  findSymbols,
  getCodeDependencies,
  getCodeDependents,
  readGitDiff,
  type CodeGraph,
  type CodeGraphNodeData,
  type GraphNode,
} from "./index.js";

export async function runCli(arguments_: readonly string[]): Promise<number> {
  const { argumentsWithoutRoot, rootDirectory } = parseRoot(arguments_);
  const [command, ...operands] = argumentsWithoutRoot;
  if (command === undefined || command === "help" || command === "--help") {
    printUsage();
    return 0;
  }

  const effectiveRoot = command === "index" && operands[0] !== undefined
    ? operands[0]
    : rootDirectory;
  const analysis = await analyzeProject(effectiveRoot);
  const graph = analysis.graph;

  switch (command) {
    case "index": {
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

function parseRoot(arguments_: readonly string[]): {
  readonly argumentsWithoutRoot: readonly string[];
  readonly rootDirectory: string;
} {
  const result = [...arguments_];
  const rootIndex = result.indexOf("--root");
  if (rootIndex === -1) {
    return { argumentsWithoutRoot: result, rootDirectory: process.cwd() };
  }
  const root = result[rootIndex + 1];
  if (root === undefined) {
    throw new Error("--root requires a directory");
  }
  result.splice(rootIndex, 2);
  return { argumentsWithoutRoot: result, rootDirectory: root };
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
    "  codegraph index [root]",
    "  codegraph find <query> [--root <directory>]",
    "  codegraph deps <symbol> [--root <directory>]",
    "  codegraph dependents <symbol> [--root <directory>]",
    "  codegraph path <source> <target> [--root <directory>]",
    "  codegraph impact <symbol> [--root <directory>]",
    "  codegraph diff [--root <directory>]",
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
