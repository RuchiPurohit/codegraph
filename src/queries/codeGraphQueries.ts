import type { GraphNode } from "../graph/types.js";
import type {
  CodeGraph,
  CodeGraphEdgeType,
  CodeGraphNodeData,
  SymbolNodeData,
} from "../analyzer/buildDefinitionGraph.js";

const DEFAULT_DEPENDENCY_RELATIONSHIPS: readonly CodeGraphEdgeType[] = [
  "CALLS",
  "IMPORTS",
];

export function findSymbols(
  graph: CodeGraph,
  query: string,
): readonly GraphNode<SymbolNodeData>[] {
  const normalizedQuery = query.toLocaleLowerCase();

  return graph
    .getNodes()
    .filter(
      (node): node is GraphNode<SymbolNodeData> =>
        node.data.nodeType === "symbol" &&
        (node.data.name.toLocaleLowerCase().includes(normalizedQuery) ||
          node.data.qualifiedName.toLocaleLowerCase().includes(normalizedQuery)),
    )
    .sort((left, right) => {
      const leftExact = left.data.qualifiedName.toLocaleLowerCase() === normalizedQuery;
      const rightExact = right.data.qualifiedName.toLocaleLowerCase() === normalizedQuery;
      if (leftExact !== rightExact) {
        return leftExact ? -1 : 1;
      }
      return left.data.qualifiedName.localeCompare(right.data.qualifiedName);
    });
}

export function getCodeDependencies(
  graph: CodeGraph,
  nodeId: string,
  relationships: readonly CodeGraphEdgeType[] = DEFAULT_DEPENDENCY_RELATIONSHIPS,
): readonly GraphNode<CodeGraphNodeData>[] {
  const allowed = new Set(relationships);
  return graph
    .getOutgoingEdges(nodeId)
    .filter((edge) => allowed.has(edge.type))
    .map((edge) => requiredNode(graph, edge.to));
}

export function getCodeDependents(
  graph: CodeGraph,
  nodeId: string,
  relationships: readonly CodeGraphEdgeType[] = DEFAULT_DEPENDENCY_RELATIONSHIPS,
): readonly GraphNode<CodeGraphNodeData>[] {
  const allowed = new Set(relationships);
  return graph
    .getIncomingEdges(nodeId)
    .filter((edge) => allowed.has(edge.type))
    .map((edge) => requiredNode(graph, edge.from));
}

export function findCodePath(
  graph: CodeGraph,
  sourceId: string,
  targetId: string,
  relationships: readonly CodeGraphEdgeType[] = DEFAULT_DEPENDENCY_RELATIONSHIPS,
): readonly string[] | null {
  requiredNode(graph, sourceId);
  requiredNode(graph, targetId);
  if (sourceId === targetId) {
    return [sourceId];
  }

  const allowed = new Set(relationships);
  const visited = new Set<string>([sourceId]);
  const parent = new Map<string, string>();
  const queue = [sourceId];
  let nextIndex = 0;

  while (nextIndex < queue.length) {
    const currentId = queue[nextIndex];
    nextIndex += 1;
    if (currentId === undefined) {
      continue;
    }

    for (const edge of graph.getOutgoingEdges(currentId)) {
      if (!allowed.has(edge.type) || visited.has(edge.to)) {
        continue;
      }
      visited.add(edge.to);
      parent.set(edge.to, currentId);
      if (edge.to === targetId) {
        return reconstructPath(parent, sourceId, targetId);
      }
      queue.push(edge.to);
    }
  }

  return null;
}

function reconstructPath(
  parent: ReadonlyMap<string, string>,
  sourceId: string,
  targetId: string,
): readonly string[] {
  const reversed = [targetId];
  let currentId = targetId;
  while (currentId !== sourceId) {
    const parentId = parent.get(currentId);
    if (parentId === undefined) {
      throw new Error("Internal query invariant failed while rebuilding path");
    }
    reversed.push(parentId);
    currentId = parentId;
  }
  return reversed.reverse();
}

function requiredNode(
  graph: CodeGraph,
  nodeId: string,
): GraphNode<CodeGraphNodeData> {
  const node = graph.getNode(nodeId);
  if (node === undefined) {
    throw new Error(`Node does not exist: ${nodeId}`);
  }
  return node;
}
