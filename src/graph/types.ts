/** A vertex in the graph, identified independently of its payload. */
export interface GraphNode<NodeData> {
  readonly id: string;
  readonly data: NodeData;
}

/** A directed, typed relationship from one node to another. */
export interface GraphEdge<EdgeType extends string, EdgeData> {
  readonly from: string;
  readonly to: string;
  readonly type: EdgeType;
  readonly data?: EdgeData;
}
