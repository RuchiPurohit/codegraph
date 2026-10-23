import ts from "typescript";

export type DeclarationKind = "function" | "class" | "interface" | "method";

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface SourceRange {
  readonly file: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface ExtractedDeclaration {
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly parentQualifiedName: string | null;
  readonly location: SourceLocation;
  readonly range: SourceRange;
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
  const seenQualifiedNames = new Set<string>();

  function addDeclaration(
    kind: DeclarationKind,
    name: string,
    qualifiedName: string,
    parentQualifiedName: string | null,
    declarationNode: ts.Node,
    nameNode: ts.Node,
  ): void {
    // Block-scoped helpers and overload signatures can repeat a qualified
    // name within one file; the first declaration owns the symbol ID.
    if (seenQualifiedNames.has(qualifiedName)) {
      return;
    }
    seenQualifiedNames.add(qualifiedName);

    const position = sourceFile.getLineAndCharacterOfPosition(
      nameNode.getStart(sourceFile),
    );
    const rangeStart = sourceFile.getLineAndCharacterOfPosition(
      declarationNode.getStart(sourceFile),
    );
    const rangeEnd = sourceFile.getLineAndCharacterOfPosition(
      declarationNode.getEnd(),
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
      range: {
        file: sourceFile.fileName,
        startLine: rangeStart.line + 1,
        startColumn: rangeStart.character + 1,
        endLine: rangeEnd.line + 1,
        endColumn: rangeEnd.character + 1,
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
      addDeclaration(
        "function",
        name,
        qualifiedName,
        parentQualifiedName,
        node,
        node.name,
      );

      ts.forEachChild(node, (child) => visit(child, qualifiedName));
      return;
    }

    if (ts.isClassDeclaration(node)) {
      if (node.name === undefined) {
        return;
      }

      const name = node.name.text;
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration(
        "class",
        name,
        qualifiedName,
        parentQualifiedName,
        node,
        node.name,
      );

      for (const member of node.members) {
        visit(member, qualifiedName);
      }

      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration(
        "interface",
        name,
        qualifiedName,
        parentQualifiedName,
        node,
        node.name,
      );

      for (const member of node.members) {
        visit(member, qualifiedName);
      }

      return;
    }

    const isClassMethod =
      ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent);
    const isInterfaceMethod =
      ts.isMethodSignature(node) && ts.isInterfaceDeclaration(node.parent);

    if (
      parentQualifiedName !== null &&
      (isClassMethod || isInterfaceMethod)
    ) {
      const name = node.name.getText(sourceFile);
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration(
        "method",
        name,
        qualifiedName,
        parentQualifiedName,
        node,
        node.name,
      );

      ts.forEachChild(node, (child) => visit(child, qualifiedName));
      return;
    }

    // `const handler = async () => {}` and `const handler = function () {}`
    // are functions in every way that matters to callers.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isFunctionInitializer(node.initializer)
    ) {
      const name = node.name.text;
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration(
        "function",
        name,
        qualifiedName,
        parentQualifiedName,
        node,
        node.name,
      );

      ts.forEachChild(node.initializer, (child) => visit(child, qualifiedName));
      return;
    }

    // Class fields initialised with a function (`handle = async () => {}`).
    if (
      parentQualifiedName !== null &&
      ts.isPropertyDeclaration(node) &&
      ts.isClassDeclaration(node.parent) &&
      node.initializer !== undefined &&
      isFunctionInitializer(node.initializer)
    ) {
      const name = node.name.getText(sourceFile);
      const qualifiedName = qualifyName(parentQualifiedName, name);
      addDeclaration(
        "method",
        name,
        qualifiedName,
        parentQualifiedName,
        node,
        node.name,
      );

      ts.forEachChild(node.initializer, (child) => visit(child, qualifiedName));
      return;
    }

    ts.forEachChild(node, (child) => visit(child, parentQualifiedName));
  }

  visit(sourceFile, null);
  return declarations;
}

export function isFunctionInitializer(
  node: ts.Expression,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}
