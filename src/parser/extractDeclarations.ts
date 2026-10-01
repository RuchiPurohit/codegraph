import ts from "typescript";

export type DeclarationKind = "function" | "class" | "interface" | "method";

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface ExtractedDeclaration {
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly location: SourceLocation;
}

/**
 * Extracts a deliberately small set of named declarations from one AST.
 *
 * This is syntax extraction, not symbol resolution: two declarations with the
 * same name are still separate syntax nodes and are not linked semantically.
 */
export function extractDeclarations(
  sourceFile: ts.SourceFile,
): readonly ExtractedDeclaration[] {
  const declarations: ExtractedDeclaration[] = [];

  function addDeclaration(
    kind: DeclarationKind,
    name: string,
    qualifiedName: string,
    node: ts.Node,
  ): void {
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );

    declarations.push({
      kind,
      name,
      qualifiedName,
      location: {
        file: sourceFile.fileName,
        line: position.line + 1,
        column: position.character + 1,
      },
    });
  }

  function visit(node: ts.Node, containerName?: string): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      addDeclaration("function", node.name.text, node.name.text, node.name);
    }

    if (ts.isClassDeclaration(node)) {
      if (node.name === undefined) {
        return;
      }

      addDeclaration("class", node.name.text, node.name.text, node.name);

      for (const member of node.members) {
        visit(member, node.name.text);
      }

      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      addDeclaration("interface", node.name.text, node.name.text, node.name);

      for (const member of node.members) {
        visit(member, node.name.text);
      }

      return;
    }

    if (
      containerName !== undefined &&
      (ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
    ) {
      const name = node.name.getText(sourceFile);
      addDeclaration("method", name, `${containerName}.${name}`, node.name);
    }

    ts.forEachChild(node, (child) => visit(child, containerName));
  }

  visit(sourceFile);
  return declarations;
}
