import type ts from "typescript";

import { DirectedGraph } from "../graph/DirectedGraph.js";
import {
  extractDeclarations,
  type DeclarationKind,
  type SourceLocation,
  type SourceRange,
} from "../parser/extractDeclarations.js";

export interface FileNodeData {
  readonly nodeType: "file";
  readonly filePath: string;
}

export interface SymbolNodeData {
  readonly nodeType: "symbol";
  readonly declarationKind: DeclarationKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly location: SourceLocation;
  readonly range: SourceRange;
}

export type CodeGraphNodeData = FileNodeData | SymbolNodeData;
export type CodeGraphEdgeType = "DEFINES" | "IMPORTS" | "CALLS";
export type ResolutionConfidence = "exact" | "inferred";

export interface DefinesEdgeData {
  readonly relationship: "DEFINES";
  readonly confidence: "exact";
  readonly provenance: "syntax";
}

export interface ImportEdgeData {
  readonly relationship: "IMPORTS";
  readonly confidence: "exact";
  readonly provenance: "typescript-module-resolution";
  readonly moduleSpecifier: string;
  readonly importKind:
    | "side-effect"
    | "default"
    | "named"
    | "namespace"
    | "mixed"
    | "re-export";
}

export interface CallEdgeData {
  readonly relationship: "CALLS";
  readonly confidence: ResolutionConfidence;
  readonly provenance: "typescript-type-checker";
  readonly location: SourceLocation;
}

export type CodeGraphEdgeData =
  | DefinesEdgeData
  | ImportEdgeData
  | CallEdgeData;

export type CodeGraph = DirectedGraph<
  CodeGraphNodeData,
  CodeGraphEdgeType,
  CodeGraphEdgeData
>;
export type DefinitionGraph = CodeGraph;

export interface BuildDefinitionGraphOptions {
  readonly getFilePath?: (sourceFile: ts.SourceFile) => string;
}

export function createFileNodeId(filePath: string): string {
  return `file:${encodeURIComponent(filePath)}`;
}

export function createSymbolNodeId(
  filePath: string,
  qualifiedName: string,
): string {
  return [
    "symbol",
    encodeURIComponent(filePath),
    encodeURIComponent(qualifiedName),
  ].join(":");
}

/** Builds file/symbol nodes and their DEFINES relationships from parsed ASTs. */
export function buildDefinitionGraph(
  sourceFiles: readonly ts.SourceFile[],
  options: BuildDefinitionGraphOptions = {},
): DefinitionGraph {
  const graph = new DirectedGraph<
    CodeGraphNodeData,
    CodeGraphEdgeType,
    CodeGraphEdgeData
  >();

  for (const sourceFile of sourceFiles) {
    const filePath = options.getFilePath?.(sourceFile) ?? sourceFile.fileName;
    const fileNodeId = createFileNodeId(filePath);
    const declarations = extractDeclarations(sourceFile);

    graph.addNode({
      id: fileNodeId,
      data: {
        nodeType: "file",
        filePath,
      },
    });

    // Add all declaration nodes before their edges so edge insertion never
    // depends on the order in which declarations were extracted.
    for (const declaration of declarations) {
      graph.addNode({
        id: createSymbolNodeId(filePath, declaration.qualifiedName),
        data: {
          nodeType: "symbol",
          declarationKind: declaration.kind,
          name: declaration.name,
          qualifiedName: declaration.qualifiedName,
          location: { ...declaration.location, file: filePath },
          range: { ...declaration.range, file: filePath },
        },
      });
    }

    for (const declaration of declarations) {
      const ownerNodeId =
        declaration.parentQualifiedName === null
          ? fileNodeId
          : createSymbolNodeId(filePath, declaration.parentQualifiedName);

      graph.addEdge({
        from: ownerNodeId,
        to: createSymbolNodeId(filePath, declaration.qualifiedName),
        type: "DEFINES",
        data: {
          relationship: "DEFINES",
          confidence: "exact",
          provenance: "syntax",
        },
      });
    }
  }

  return graph;
}
