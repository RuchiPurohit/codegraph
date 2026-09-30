import ts from "typescript";

/** Parses TypeScript or TSX source text into a TypeScript AST. */
export function parseSourceFile(
  fileName: string,
  sourceText: string,
): ts.SourceFile {
  const scriptKind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;

  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}
