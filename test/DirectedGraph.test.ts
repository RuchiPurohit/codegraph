import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DirectedGraph } from "../src/index.js";

type Relation = "CALLS" | "IMPORTS";

function createGraph(): DirectedGraph<{ readonly label: string }, Relation> {
  return new DirectedGraph<{ readonly label: string }, Relation>();
}

function addNodes(
  graph: DirectedGraph<{ readonly label: string }, Relation>,
  ...ids: readonly string[]
): void {
  for (const id of ids) {
    graph.addNode({ id, data: { label: id } });
  }
}

describe("nodes", () => {
  it("adds and retrieves a node", () => {
    const graph = createGraph();
    const node = { id: "A", data: { label: "alpha" } };

    graph.addNode(node);

    assert.equal(graph.getNode("A"), node);
    assert.equal(graph.nodeCount, 1);
  });

  it("rejects a duplicate node ID", () => {
    const graph = createGraph();
    addNodes(graph, "A");

    assert.throws(
      () => graph.addNode({ id: "A", data: { label: "replacement" } }),
      /Node already exists: A/,
    );
  });

  it("returns undefined for a nonexistent node", () => {
    const graph = createGraph();

    assert.equal(graph.getNode("missing"), undefined);
  });
});

describe("edges", () => {
  it("adds a directed edge", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B");

    graph.addEdge({ from: "A", to: "B", type: "CALLS" });

    assert.deepEqual(
      graph.getNeighbors("A").map((node) => node.id),
      ["B"],
    );
    assert.deepEqual(graph.getNeighbors("B"), []);
    assert.equal(graph.edgeCount, 1);
  });

  it("rejects a duplicate from/to/type edge", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B");
    graph.addEdge({ from: "A", to: "B", type: "CALLS" });

    assert.throws(
      () => graph.addEdge({ from: "A", to: "B", type: "CALLS" }),
      /Edge already exists/,
    );
  });

  it("allows multiple relationship types between the same nodes", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B");

    graph.addEdge({ from: "A", to: "B", type: "CALLS" });
    graph.addEdge({ from: "A", to: "B", type: "IMPORTS" });

    assert.equal(graph.edgeCount, 2);
    assert.deepEqual(
      graph.getDependencies("A").map((node) => node.id),
      ["B"],
    );
  });

  it("rejects an edge with a missing source", () => {
    const graph = createGraph();
    addNodes(graph, "B");

    assert.throws(
      () => graph.addEdge({ from: "missing", to: "B", type: "CALLS" }),
      /Node does not exist: missing/,
    );
  });

  it("rejects an edge with a missing destination", () => {
    const graph = createGraph();
    addNodes(graph, "A");

    assert.throws(
      () => graph.addEdge({ from: "A", to: "missing", type: "CALLS" }),
      /Node does not exist: missing/,
    );
  });

  it("allows a self edge", () => {
    const graph = createGraph();
    addNodes(graph, "A");

    graph.addEdge({ from: "A", to: "A", type: "CALLS" });

    assert.deepEqual(
      graph.getDependencies("A").map((node) => node.id),
      ["A"],
    );
    assert.deepEqual(graph.bfs("A"), ["A"]);
  });
});

describe("relationship queries", () => {
  it("returns outgoing dependencies once in insertion order", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B", "C");
    graph.addEdge({ from: "A", to: "B", type: "CALLS" });
    graph.addEdge({ from: "A", to: "C", type: "CALLS" });

    assert.deepEqual(
      graph.getDependencies("A").map((node) => node.id),
      ["B", "C"],
    );
  });

  it("returns incoming dependents once in insertion order", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B", "C");
    graph.addEdge({ from: "A", to: "C", type: "CALLS" });
    graph.addEdge({ from: "B", to: "C", type: "CALLS" });

    assert.deepEqual(
      graph.getDependents("C").map((node) => node.id),
      ["A", "B"],
    );
  });

  it("rejects queries for a missing node", () => {
    const graph = createGraph();

    assert.throws(() => graph.getDependencies("missing"), /Node does not exist/);
    assert.throws(() => graph.getDependents("missing"), /Node does not exist/);
  });
});

describe("traversal", () => {
  function createTraversalGraph(): DirectedGraph<
    { readonly label: string },
    Relation
  > {
    const graph = createGraph();
    addNodes(graph, "A", "B", "C", "D", "E");
    graph.addEdge({ from: "A", to: "B", type: "CALLS" });
    graph.addEdge({ from: "A", to: "C", type: "CALLS" });
    graph.addEdge({ from: "B", to: "D", type: "CALLS" });
    graph.addEdge({ from: "C", to: "E", type: "CALLS" });
    return graph;
  }

  it("visits breadth-first in deterministic order", () => {
    assert.deepEqual(createTraversalGraph().bfs("A"), ["A", "B", "C", "D", "E"]);
  });

  it("visits depth-first in deterministic order", () => {
    assert.deepEqual(createTraversalGraph().dfs("A"), ["A", "B", "D", "C", "E"]);
  });

  it("terminates when the graph contains a cycle", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B", "C");
    graph.addEdge({ from: "A", to: "B", type: "CALLS" });
    graph.addEdge({ from: "B", to: "C", type: "CALLS" });
    graph.addEdge({ from: "C", to: "A", type: "CALLS" });

    assert.deepEqual(graph.bfs("A"), ["A", "B", "C"]);
    assert.deepEqual(graph.dfs("A"), ["A", "B", "C"]);
  });

  it("does not cross into a disconnected component", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B", "C", "D");
    graph.addEdge({ from: "A", to: "B", type: "CALLS" });
    graph.addEdge({ from: "C", to: "D", type: "CALLS" });

    assert.deepEqual(graph.bfs("A"), ["A", "B"]);
    assert.deepEqual(graph.dfs("A"), ["A", "B"]);
  });
});

describe("findPath", () => {
  it("returns a shortest path by edge count", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B", "C", "D", "E");
    graph.addEdge({ from: "A", to: "B", type: "CALLS" });
    graph.addEdge({ from: "B", to: "C", type: "CALLS" });
    graph.addEdge({ from: "C", to: "D", type: "CALLS" });
    graph.addEdge({ from: "A", to: "E", type: "CALLS" });
    graph.addEdge({ from: "E", to: "D", type: "CALLS" });

    assert.deepEqual(graph.findPath("A", "D"), ["A", "E", "D"]);
  });

  it("returns null when no directed path exists", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B", "C");
    graph.addEdge({ from: "A", to: "B", type: "CALLS" });

    assert.equal(graph.findPath("A", "C"), null);
    assert.equal(graph.findPath("B", "A"), null);
  });

  it("returns the source when source equals target", () => {
    const graph = createGraph();
    addNodes(graph, "A");

    assert.deepEqual(graph.findPath("A", "A"), ["A"]);
  });

  it("handles a cycle while searching for a path", () => {
    const graph = createGraph();
    addNodes(graph, "A", "B", "C", "D");
    graph.addEdge({ from: "A", to: "B", type: "CALLS" });
    graph.addEdge({ from: "B", to: "C", type: "CALLS" });
    graph.addEdge({ from: "C", to: "A", type: "CALLS" });
    graph.addEdge({ from: "C", to: "D", type: "CALLS" });

    assert.deepEqual(graph.findPath("A", "D"), ["A", "B", "C", "D"]);
  });
});
