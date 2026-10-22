import path from "node:path";

import type { ProjectAnalysis } from "./analyzeProject.js";
import { analyzeProject } from "./analyzeProject.js";
import {
  createFileNodeId,
  type CodeGraph,
  type CodeGraphNodeData,
} from "./buildDefinitionGraph.js";
import {
  loadProjectAnalysis,
  saveProjectAnalysis,
} from "../persistence/jsonPersistence.js";

export interface FileChanges {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
  readonly affected: readonly string[];
  readonly reused: readonly string[];
}

export interface IncrementalUpdateResult {
  readonly analysis: ProjectAnalysis;
  readonly files: FileChanges;
}

export async function updateProjectIndex(
  indexPath: string,
  rootDirectory?: string,
): Promise<IncrementalUpdateResult> {
  const cached = await loadProjectAnalysis(indexPath);
  const fresh = await analyzeProject(rootDirectory ?? cached.rootDirectory);
  const result = updateProjectAnalysis(cached, fresh);
  await saveProjectAnalysis(result.analysis, indexPath);
  return result;
}

/**
 * Applies a fresh semantic snapshot to only the affected portion of a cached
 * graph. The fresh snapshot currently comes from a project-wide TypeScript
 * Program so cross-file symbol resolution remains correct.
 */
export function updateProjectAnalysis(
  cached: ProjectAnalysis,
  fresh: ProjectAnalysis,
): IncrementalUpdateResult {
  const directChanges = compareFileHashes(cached.fileHashes, fresh.fileHashes);
  const affected = new Set<string>([
    ...directChanges.added,
    ...directChanges.changed,
    ...directChanges.deleted,
  ]);

  expandReverseImportDependents(cached.graph, affected);
  expandReverseImportDependents(fresh.graph, affected);
  patchAffectedGraph(cached.graph, fresh.graph, affected);

  const currentFiles = Object.keys(fresh.fileHashes).sort();
  const affectedFiles = [...affected].sort();
  const analysis: ProjectAnalysis = {
    rootDirectory: fresh.rootDirectory,
    graph: cached.graph,
    diagnostics: fresh.diagnostics,
    fileHashes: fresh.fileHashes,
  };

  return {
    analysis,
    files: {
      ...directChanges,
      affected: affectedFiles,
      reused: currentFiles.filter((file) => !affected.has(file)),
    },
  };
}

function compareFileHashes(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Pick<FileChanges, "added" | "changed" | "deleted"> {
  const previousPaths = new Set(Object.keys(previous));
  const currentPaths = new Set(Object.keys(current));
  const added = [...currentPaths].filter((file) => !previousPaths.has(file));
  const deleted = [...previousPaths].filter((file) => !currentPaths.has(file));
  const changed = [...currentPaths].filter(
    (file) => previousPaths.has(file) && previous[file] !== current[file],
  );

  return {
    added: added.sort(),
    changed: changed.sort(),
    deleted: deleted.sort(),
  };
}

function expandReverseImportDependents(
  graph: CodeGraph,
  affected: Set<string>,
): void {
  const queue = [...affected];
  let nextIndex = 0;

  while (nextIndex < queue.length) {
    const filePath = queue[nextIndex];
    nextIndex += 1;
    if (filePath === undefined) {
      continue;
    }
    const fileNode = graph.getNode(createFileNodeId(filePath));
    if (fileNode === undefined) {
      continue;
    }

    for (const edge of graph.getIncomingEdges(fileNode.id)) {
      if (edge.type !== "IMPORTS") {
        continue;
      }
      const importer = graph.getNode(edge.from);
      if (importer?.data.nodeType !== "file" || affected.has(importer.data.filePath)) {
        continue;
      }
      affected.add(importer.data.filePath);
      queue.push(importer.data.filePath);
    }
  }
}

function patchAffectedGraph(
  cached: CodeGraph,
  fresh: CodeGraph,
  affected: ReadonlySet<string>,
): void {
  for (const node of cached.getNodes()) {
    if (affected.has(filePathForNode(node.data))) {
      cached.removeNode(node.id);
    }
  }

  for (const node of fresh.getNodes()) {
    if (affected.has(filePathForNode(node.data))) {
      cached.addNode(node);
    }
  }

  for (const edge of fresh.getEdges()) {
    const source = fresh.getNode(edge.from);
    const target = fresh.getNode(edge.to);
    if (source === undefined || target === undefined) {
      throw new Error("Fresh graph contains an edge with a missing endpoint");
    }
    const touchesAffected =
      affected.has(filePathForNode(source.data)) ||
      affected.has(filePathForNode(target.data));
    if (
      touchesAffected &&
      cached.getNode(edge.from) !== undefined &&
      cached.getNode(edge.to) !== undefined &&
      !cached.hasEdge(edge.from, edge.to, edge.type)
    ) {
      cached.addEdge(edge);
    }
  }
}

function filePathForNode(node: CodeGraphNodeData): string {
  return node.nodeType === "file" ? node.filePath : node.location.file;
}

export function defaultIndexPath(rootDirectory: string): string {
  return path.join(rootDirectory, ".codeskope", "index.json");
}
