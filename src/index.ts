export { analyzeProject } from "./analyzer/analyzeProject.js";
export type {
  AnalysisDiagnostic,
  AnalysisDiagnosticKind,
  ProjectAnalysis,
} from "./analyzer/analyzeProject.js";
export {
  defaultIndexPath,
  updateProjectAnalysis,
  updateProjectIndex,
} from "./analyzer/incrementalIndex.js";
export type {
  FileChanges,
  IncrementalUpdateResult,
} from "./analyzer/incrementalIndex.js";
export {
  buildDefinitionGraph,
  createFileNodeId,
  createSymbolNodeId,
} from "./analyzer/buildDefinitionGraph.js";
export type {
  BuildDefinitionGraphOptions,
  CallEdgeData,
  CodeGraph,
  CodeGraphEdgeData,
  CodeGraphEdgeType,
  CodeGraphNodeData,
  DefinesEdgeData,
  DefinitionGraph,
  FileNodeData,
  ImportEdgeData,
  ResolutionConfidence,
  SymbolNodeData,
} from "./analyzer/buildDefinitionGraph.js";
export { discoverSourceFiles } from "./files/discoverSourceFiles.js";
export {
  analyzeDiffImpact,
  parseGitDiff,
  readGitDiff,
} from "./git/diffImpact.js";
export type {
  ChangedFileLines,
  DiffImpactResult,
  UnmappedChangedLine,
} from "./git/diffImpact.js";
export { DirectedGraph } from "./graph/DirectedGraph.js";
export type { GraphEdge, GraphNode } from "./graph/types.js";
export { extractDeclarations } from "./parser/extractDeclarations.js";
export type {
  DeclarationKind,
  ExtractedDeclaration,
  SourceLocation,
  SourceRange,
} from "./parser/extractDeclarations.js";
export { parseSourceFile } from "./parser/parseSourceFile.js";
export {
  CODEGRAPH_JSON_SCHEMA_VERSION,
  deserializeProjectAnalysis,
  loadProjectAnalysis,
  saveProjectAnalysis,
  serializeProjectAnalysis,
} from "./persistence/jsonPersistence.js";
export { analyzeImpact } from "./queries/analyzeImpact.js";
export type {
  ImpactOptions,
  ImpactResult,
} from "./queries/analyzeImpact.js";
export {
  findCodePath,
  findSymbols,
  getCodeDependencies,
  getCodeDependents,
} from "./queries/codeGraphQueries.js";
