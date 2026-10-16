import type ts from "typescript";

import { DirectedGraph } from "../graph/DirectedGraph.js";
import {
  extractDeclarations,
  type DeclarationKind,
  type SourceLocation,
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
}

export type CodeGraphNodeData = FileNodeData | SymbolNodeData;
export type CodeGraphEdgeType = "DEFINES";
export type DefinitionGraph = DirectedGraph<
  CodeGraphNodeData,
  CodeGraphEdgeType
>;

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
): DefinitionGraph {
  const graph = new DirectedGraph<CodeGraphNodeData, CodeGraphEdgeType>();

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.fileName;
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
          location: declaration.location,
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
      });
    }
  }

  return graph;
}
