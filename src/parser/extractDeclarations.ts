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
  readonly parentQualifiedName: string | null;
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
    parentQualifiedName: string | null,
    node: ts.Node,
  ): void {
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );

    declarations.push({
      kind,
      name,
      qualifiedName,
      parentQualifiedName,
      location: {
        file: sourceFile.fileName,
        line: position.line + 1,
        column: position.character + 1,
      },
    });
  }

  function qualifyName(parentQualifiedName: string | null, name: string): string {
    if (parentQualifiedName === null) {
      return name;
    }

    return `${parentQualifiedName}.${name}`;
  }

  function visit(node: ts.Node, parentQualifiedName: string | null): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const name = node.name.text;
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration("function", node.name.text, qualifiedName, parentQualifiedName, node.name);
    }

    if (ts.isClassDeclaration(node)) {
      if (node.name === undefined) {
        return;
      }

      const name = node.name.text;
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration("function", node.name.text, qualifiedName, parentQualifiedName, node.name);

      for (const member of node.members) {
        visit(member, qualifiedName);
      }

      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration("function", node.name.text, qualifiedName, parentQualifiedName, node.name);

      for (const member of node.members) {
        visit(member, qualifiedName);
      }

      return;
    }

    const isClassMethod = ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent);
    const isInterfaceMethod = ts.isMethodSignature(node) && ts.isInterfaceDeclaration(node.parent);

    if (
      parentQualifiedName !== null &&
      (isClassMethod || isInterfaceMethod)
    ) {
      const name = node.name.getText(sourceFile);
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration("method", name, qualifiedName, parentQualifiedName, node.name);
    }

    ts.forEachChild(node, (child) => visit(child, parentQualifiedName));
  }

  visit(sourceFile, null);
  return declarations;
}
