# Codegraph

Codegraph will statically analyze source repositories and expose trustworthy code
relationships as a graph. Phase 1 deliberately contains only a reusable directed
graph engine; it does not parse TypeScript source code yet.

## The graph model

A **node** (or vertex) represents an entity. An **edge** represents a relationship
between two nodes. In a directed graph, the arrow has meaning:

```text
AuthController.login --CALLS--> AuthService.login --CALLS--> TokenService.generate
```

The first method calls—and therefore depends on—the second. If `A -> B` means A
depends on B, `dependencies(A)` follows outgoing arrows and `dependents(B)` follows
incoming arrows backward. These queries answer different questions:

```text
dependencies(AuthController.login) = [AuthService.login]
dependents(AuthService.login)       = [AuthController.login]
```

An **outgoing edge** starts at the node being examined; an **incoming edge** ends
there. An **adjacency list** stores each node beside its outgoing relationships. A
**reverse adjacency list** stores incoming relationships too. A **traversal** visits
reachable nodes by following edges. A **cycle** is a path that returns to an already
visited node, such as `A -> B -> C -> A`. Nodes are **disconnected** when no path in
the chosen direction connects them; a traversal from one component cannot visit
another.

A directed graph fits Codegraph because relationships such as `CALLS`, `IMPORTS`,
and `EXTENDS` are directional. Who a function calls and who calls that function are
both important, but they are not interchangeable.

## Representation choice

Let `V` be the number of nodes and `E` the number of edges.

| Representation | Storage | Add edge | Get outgoing neighbors | Good fit? |
| --- | ---: | ---: | ---: | --- |
| Adjacency matrix | `O(V²)` | `O(1)` | `O(V)` | Fast edge checks, but wasteful for sparse graphs |
| Adjacency list | `O(V + E)` | expected `O(1)` | `O(out-degree)` | Best fit for Codegraph |
| Edge list | `O(E)` | `O(1)` | `O(E)` | Simple storage, slow relationship queries |

Source-code graphs are generally sparse: each symbol relates to a small fraction
of all symbols. An adjacency list stores relationships that actually exist. This
implementation stores both outgoing and reverse adjacency, using more memory—each
edge is indexed twice—to make both dependencies and dependents efficient.

The nested shape is:

```text
Map<node id, Map<neighbor id, Map<edge type, edge>>>
```

The final map makes `(from, to, type)` the edge identity. Thus duplicate `CALLS`
edges are rejected, while `A --CALLS--> B` and `A --IMPORTS--> B` can coexist.
`Map` also preserves insertion order, producing deterministic traversal results.

Approximate operation costs are:

| Operation | Time | Extra space |
| --- | ---: | ---: |
| Add node | expected `O(1)` | `O(1)` |
| Add edge | expected `O(1)` | `O(1)` (indexed twice) |
| Get dependencies | `O(out-neighbors)` | output size |
| Get dependents | `O(in-neighbors)` | output size |
| BFS / DFS | `O(V + E)` reachable | `O(V)` reachable |
| Find path with BFS | `O(V + E)` reachable | `O(V)` reachable |

An adjacency matrix would be worth reconsidering only for a small, very dense graph
where constant-time arbitrary edge checks dominate. An edge list may be useful as a
serialization format later, but is not a good query index.

## Types and TypeScript concepts

`GraphNode<NodeData>` separates stable identity (`id`) from domain data. Later,
`NodeData` can describe a file or symbol without teaching the graph engine those
concepts. `GraphEdge<EdgeType, EdgeData>` stores direction, relationship type, and
optional metadata. Later, edge data might hold source location or resolution status.

`DirectedGraph<NodeData, EdgeType, EdgeData>` introduces only three useful generics:

- `NodeData`: the application-specific node payload; defaults to `unknown`.
- `EdgeType extends string`: restricts relationships to string names while allowing
  a union such as `"CALLS" | "IMPORTS"`.
- `EdgeData`: optional relationship metadata; defaults to `unknown`.

`unknown` is safer than `any`: consumers must narrow it before using it. `readonly`
prevents mutation through these public types, although it is shallow and does not
deep-freeze nested objects. `Map<K, V>` associates unique keys with values; `Set<T>`
stores unique values and is used by traversals to remember visited node IDs.

## Behavioral decisions

- Duplicate node IDs throw. Silent overwrite could hide a symbol-ID bug.
- Edges require both endpoints to exist. This keeps every adjacency entry valid.
- Duplicate `(from, to, type)` edges throw. Different edge types may coexist.
- Neighbor and dependency queries return unique destination nodes, even if several
  edge types connect the same pair.
- `getNode` returns `undefined` when absent, matching normal `Map.get` semantics.
- Operations that require an existing node throw for a missing ID.
- Self-edges are allowed. The generic engine models facts; later domain layers can
  decide whether a particular self-relationship is meaningful.
- `findPath(A, A)` returns `[A]`, the valid zero-edge path from a node to itself.

## Important code path walkthrough

### 1. Types

[`src/graph/types.ts`](src/graph/types.ts) defines generic nodes and edges. They know
nothing about source files, functions, ASTs, or Codegraph-specific relationships.

### 2. Internal data structures

[`src/graph/DirectedGraph.ts`](src/graph/DirectedGraph.ts) holds a node `Map` and two
adjacency maps. Their `private` modifier hides implementation details. Their
`readonly` modifier prevents assigning a different map to a field; the contents of
the existing map intentionally remain mutable.

### 3. `addNode`

`addNode` checks `nodes.has(id)`, stores the node, and creates empty outgoing and
incoming buckets. Creating all three together maintains the graph invariant. The
expected time and added space are both `O(1)`.

### 4. `addEdge`

`addEdge` first validates both endpoints. It indexes the same immutable edge object
under the source's outgoing map and destination's incoming map. A nested map lookup
detects duplicates without building a delimiter-based string key (which could have
escaping or collision problems). Expected insertion time is `O(1)`.

### 5. Outgoing adjacency

For `A -> B`, the outgoing index stores B under A. Reading A's keys therefore gives
its direct dependencies. Multiple edge types to B live one level deeper and do not
duplicate B in node-level queries.

### 6. Reverse adjacency

The incoming index stores A under B for the same edge. Without it, finding B's
dependents would scan every edge, costing `O(E)`. The tradeoff is a second index and
therefore `O(E)` additional references.

### 7. Dependencies and dependents

`getDependencies` reads outgoing neighbor IDs; `getDependents` reads incoming IDs.
Both translate IDs back to nodes. Work is proportional to the number of direct
neighbors returned.

### 8. BFS

Breadth-first search uses a first-in, first-out queue, so it visits all nodes one edge
away before nodes two edges away. `nextIndex` advances through an array instead of
calling `shift()`, which would repeatedly move remaining elements. Nodes enter the
visited `Set` when enqueued, preventing duplicates and guaranteeing termination on
cycles. Across the reachable graph, time is `O(V + E)` and space is `O(V)`.

### 9. DFS

Depth-first search uses an explicit last-in, first-out stack rather than recursion.
This avoids overflowing JavaScript's call stack on a deep repository graph. Neighbors
are pushed in reverse so the earliest inserted neighbor is visited first. DFS has the
same asymptotic bounds as BFS, but explores deeply before returning to siblings.
Neither order is universally better; they answer different traversal needs.

### 10. `findPath`

Path search uses BFS, which finds a minimum-edge path in an unweighted graph. When B
is first discovered from A it records `parent[B] = A`. On reaching the target, it
walks parents backward and reverses the result. A parent map is more memory-efficient
than copying a complete path into every queue entry. Time is `O(V + E)` and auxiliary
space is `O(V)` over reachable nodes.

### 11. Tests

[`test/DirectedGraph.test.ts`](test/DirectedGraph.test.ts) covers nodes, duplicate and
invalid edges, multiple relationship types, self-edges, directionality, deterministic
BFS/DFS, cycles, disconnected components, shortest paths, missing paths, and the
zero-edge path. Node's built-in test runner supplies test organization and assertions;
Node loads the TypeScript files through `tsx` without a separate test framework.

## Run it

```bash
npm install
npm test
npm run check
npm run build
npm run example
```

## Understanding check

1. If `A -> B` means A depends on B, what do `getDependencies("A")` and
   `getDependents("B")` each return?
2. Why does this implementation pay the memory cost of an incoming adjacency map?
3. Why does adding a duplicate node throw instead of overwrite?
4. Why is an edge identified by `from + to + type`, rather than only `from + to`?
5. Why must both endpoint nodes exist before adding an edge?
6. What different jobs do `Map` and `Set` perform here?
7. Why is a node marked visited when BFS enqueues it rather than when it is removed?
8. Why does BFS produce a shortest path by edge count in this unweighted graph?
9. Why can iterative DFS be safer than recursive DFS for a large codebase?
10. Why do BFS and DFS take `O(V + E)` time and `O(V)` extra space in the worst case?
