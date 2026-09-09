import { DirectedGraph } from "../src/index.js";

type SymbolKind = "method" | "function";
type Relationship = "CALLS";

const graph = new DirectedGraph<
  { readonly kind: SymbolKind },
  Relationship
>();

graph.addNode({
  id: "AuthController.login",
  data: { kind: "method" },
});
graph.addNode({
  id: "AuthService.login",
  data: { kind: "method" },
});
graph.addNode({
  id: "TokenService.generate",
  data: { kind: "method" },
});

graph.addEdge({
  from: "AuthController.login",
  to: "AuthService.login",
  type: "CALLS",
});
graph.addEdge({
  from: "AuthService.login",
  to: "TokenService.generate",
  type: "CALLS",
});

console.log(
  "Dependencies of AuthController.login:",
  graph.getDependencies("AuthController.login").map((node) => node.id),
);
console.log(
  "Dependents of AuthService.login:",
  graph.getDependents("AuthService.login").map((node) => node.id),
);
console.log(
  "Path to TokenService.generate:",
  graph.findPath("AuthController.login", "TokenService.generate"),
);
