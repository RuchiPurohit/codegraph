import type { GraphEdge, GraphNode } from "./types.js";

type EdgeByType<EdgeType extends string, EdgeData> = Map<
  EdgeType,
  GraphEdge<EdgeType, EdgeData>
>;

type EdgeByNeighbor<EdgeType extends string, EdgeData> = Map<
  string,
  EdgeByType<EdgeType, EdgeData>
>;

/**
 * A generic directed graph with deterministic insertion-order traversal.
 *
 * A -> B means A depends on B. Outgoing adjacency therefore answers
 * dependency queries, while incoming adjacency answers dependent queries.
 */
export class DirectedGraph<
  NodeData = unknown,
  EdgeType extends string = string,
  EdgeData = unknown,
> {
  private readonly nodes = new Map<string, GraphNode<NodeData>>();
  private readonly outgoing = new Map<
    string,
    EdgeByNeighbor<EdgeType, EdgeData>
  >();
  private readonly incoming = new Map<
    string,
    EdgeByNeighbor<EdgeType, EdgeData>
  >();

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    let count = 0;

    for (const edgesByNeighbor of this.outgoing.values()) {
      for (const edgesByType of edgesByNeighbor.values()) {
        count += edgesByType.size;
      }
    }

    return count;
  }

  addNode(node: GraphNode<NodeData>): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`Node already exists: ${node.id}`);
    }

    this.nodes.set(node.id, node);
    this.outgoing.set(node.id, new Map());
    this.incoming.set(node.id, new Map());
  }

  addEdge(edge: GraphEdge<EdgeType, EdgeData>): void {
    this.assertNodeExists(edge.from);
    this.assertNodeExists(edge.to);

    const outgoingFromSource = this.getAdjacencyBucket(this.outgoing, edge.from);
    const edgesToDestination = this.getOrCreateNeighborBucket(
      outgoingFromSource,
      edge.to,
    );

    if (edgesToDestination.has(edge.type)) {
      throw new Error(
        `Edge already exists: ${edge.from} -[${edge.type}]-> ${edge.to}`,
      );
    }

    edgesToDestination.set(edge.type, edge);

    const incomingToDestination = this.getAdjacencyBucket(
      this.incoming,
      edge.to,
    );
    const edgesFromSource = this.getOrCreateNeighborBucket(
      incomingToDestination,
      edge.from,
    );
    edgesFromSource.set(edge.type, edge);
  }

  getNode(id: string): GraphNode<NodeData> | undefined {
    return this.nodes.get(id);
  }

  /** Returns nodes at the destination of this node's outgoing edges. */
  getNeighbors(id: string): readonly GraphNode<NodeData>[] {
    return this.getDependencies(id);
  }

  /** Returns the direct nodes that `id` depends on. */
  getDependencies(id: string): readonly GraphNode<NodeData>[] {
    this.assertNodeExists(id);
    return this.nodesForIds(this.getNeighborIds(this.outgoing, id));
  }

  /** Returns the direct nodes that depend on `id`. */
  getDependents(id: string): readonly GraphNode<NodeData>[] {
    this.assertNodeExists(id);
    return this.nodesForIds(this.getNeighborIds(this.incoming, id));
  }

  /** Breadth-first traversal over outgoing edges. */
  bfs(startId: string): readonly string[] {
    this.assertNodeExists(startId);

    const visited = new Set<string>([startId]);
    const queue: string[] = [startId];
    const order: string[] = [];
    let nextIndex = 0;

    while (nextIndex < queue.length) {
      const currentId = queue[nextIndex];
      nextIndex += 1;

      // The loop condition guarantees this indexed item exists.
      if (currentId === undefined) {
        continue;
      }

      order.push(currentId);

      for (const neighborId of this.getNeighborIds(this.outgoing, currentId)) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      }
    }

    return order;
  }

  /** Iterative depth-first traversal over outgoing edges. */
  dfs(startId: string): readonly string[] {
    this.assertNodeExists(startId);

    const visited = new Set<string>();
    const stack: string[] = [startId];
    const order: string[] = [];

    while (stack.length > 0) {
      const currentId = stack.pop();

      if (currentId === undefined || visited.has(currentId)) {
        continue;
      }

      visited.add(currentId);
      order.push(currentId);

      const neighbors = [...this.getNeighborIds(this.outgoing, currentId)];

      // A stack is last-in, first-out. Reverse insertion preserves the same
      // left-to-right neighbor order users see in dependency queries.
      for (let index = neighbors.length - 1; index >= 0; index -= 1) {
        const neighborId = neighbors[index];
        if (neighborId !== undefined && !visited.has(neighborId)) {
          stack.push(neighborId);
        }
      }
    }

    return order;
  }

  /** Finds a shortest path by edge count, following outgoing edges. */
  findPath(sourceId: string, targetId: string): readonly string[] | null {
    this.assertNodeExists(sourceId);
    this.assertNodeExists(targetId);

    if (sourceId === targetId) {
      return [sourceId];
    }

    const visited = new Set<string>([sourceId]);
    const parent = new Map<string, string>();
    const queue: string[] = [sourceId];
    let nextIndex = 0;

    while (nextIndex < queue.length) {
      const currentId = queue[nextIndex];
      nextIndex += 1;

      if (currentId === undefined) {
        continue;
      }

      for (const neighborId of this.getNeighborIds(this.outgoing, currentId)) {
        if (visited.has(neighborId)) {
          continue;
        }

        visited.add(neighborId);
        parent.set(neighborId, currentId);

        if (neighborId === targetId) {
          return this.reconstructPath(parent, sourceId, targetId);
        }

        queue.push(neighborId);
      }
    }

    return null;
  }

  private assertNodeExists(id: string): void {
    if (!this.nodes.has(id)) {
      throw new Error(`Node does not exist: ${id}`);
    }
  }

  private getAdjacencyBucket(
    adjacency: Map<string, EdgeByNeighbor<EdgeType, EdgeData>>,
    id: string,
  ): EdgeByNeighbor<EdgeType, EdgeData> {
    const bucket = adjacency.get(id);

    if (bucket === undefined) {
      throw new Error(`Internal graph invariant failed for node: ${id}`);
    }

    return bucket;
  }

  private getOrCreateNeighborBucket(
    adjacency: EdgeByNeighbor<EdgeType, EdgeData>,
    neighborId: string,
  ): EdgeByType<EdgeType, EdgeData> {
    const existing = adjacency.get(neighborId);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<EdgeType, GraphEdge<EdgeType, EdgeData>>();
    adjacency.set(neighborId, created);
    return created;
  }

  private getNeighborIds(
    adjacency: Map<string, EdgeByNeighbor<EdgeType, EdgeData>>,
    id: string,
  ): IterableIterator<string> {
    return this.getAdjacencyBucket(adjacency, id).keys();
  }

  private nodesForIds(ids: Iterable<string>): readonly GraphNode<NodeData>[] {
    const result: GraphNode<NodeData>[] = [];

    for (const id of ids) {
      const node = this.nodes.get(id);

      if (node === undefined) {
        throw new Error(`Internal graph invariant failed for node: ${id}`);
      }

      result.push(node);
    }

    return result;
  }

  private reconstructPath(
    parent: ReadonlyMap<string, string>,
    sourceId: string,
    targetId: string,
  ): readonly string[] {
    const reversedPath = [targetId];
    let currentId = targetId;

    while (currentId !== sourceId) {
      const parentId = parent.get(currentId);

      if (parentId === undefined) {
        throw new Error("Internal graph invariant failed while rebuilding path");
      }

      reversedPath.push(parentId);
      currentId = parentId;
    }

    return reversedPath.reverse();
  }
}
