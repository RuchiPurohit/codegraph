export { discoverSourceFiles } from "./files/discoverSourceFiles.js";
export { DirectedGraph } from "./graph/DirectedGraph.js";
export type { GraphEdge, GraphNode } from "./graph/types.js";
export { extractDeclarations } from "./parser/extractDeclarations.js";
export type {
  DeclarationKind,
  ExtractedDeclaration,
  SourceLocation,
} from "./parser/extractDeclarations.js";
export { parseSourceFile } from "./parser/parseSourceFile.js";
