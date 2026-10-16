import type { GraphNode } from "../graph/types.js";
import type {
  CodeGraph,
  CodeGraphEdgeType,
  CodeGraphNodeData,
} from "../analyzer/buildDefinitionGraph.js";

export interface ImpactOptions {
  readonly maxDepth?: number;
  readonly relationships?: readonly CodeGraphEdgeType[];
}

export interface ImpactResult {
  readonly changed: GraphNode<CodeGraphNodeData>;
  readonly directDependents: readonly GraphNode<CodeGraphNodeData>[];
  readonly indirectDependents: readonly GraphNode<CodeGraphNodeData>[];
  readonly affectedFiles: readonly string[];
}

export function analyzeImpact(
  graph: CodeGraph,
  changedNodeId: string,
  options: ImpactOptions = {},
): ImpactResult {
  const changed = graph.getNode(changedNodeId);
  if (changed === undefined) {
    throw new Error(`Node does not exist: ${changedNodeId}`);
  }

  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  if (maxDepth < 0) {
    throw new Error("maxDepth must be zero or greater");
  }
  const allowed = new Set<CodeGraphEdgeType>(
    options.relationships ?? ["CALLS", "IMPORTS"],
  );
  const visited = new Set<string>([changedNodeId]);
  const queue: Array<{ readonly id: string; readonly depth: number }> = [
    { id: changedNodeId, depth: 0 },
  ];
  const direct: GraphNode<CodeGraphNodeData>[] = [];
  const indirect: GraphNode<CodeGraphNodeData>[] = [];
  let nextIndex = 0;

  while (nextIndex < queue.length) {
    const current = queue[nextIndex];
    nextIndex += 1;
    if (current === undefined || current.depth >= maxDepth) {
      continue;
    }

    for (const edge of graph.getIncomingEdges(current.id)) {
      if (!allowed.has(edge.type) || visited.has(edge.from)) {
        continue;
      }
      visited.add(edge.from);
      const node = graph.getNode(edge.from);
      if (node === undefined) {
        throw new Error(`Internal graph invariant failed for node: ${edge.from}`);
      }
      const depth = current.depth + 1;
      if (depth === 1) {
        direct.push(node);
      } else {
        indirect.push(node);
      }
      queue.push({ id: edge.from, depth });
    }
  }

  const affectedFiles = new Set<string>();
  for (const node of [...direct, ...indirect]) {
    affectedFiles.add(
      node.data.nodeType === "file"
        ? node.data.filePath
        : node.data.location.file,
    );
  }

  return {
    changed,
    directDependents: direct,
    indirectDependents: indirect,
    affectedFiles: [...affectedFiles].sort(),
  };
}
