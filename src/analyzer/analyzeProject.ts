import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";

import { discoverSourceFiles } from "../files/discoverSourceFiles.js";
import { isFunctionInitializer } from "../parser/extractDeclarations.js";
import type { GraphNode } from "../graph/types.js";
import {
  buildDefinitionGraph,
  createFileNodeId,
  type CallEdgeData,
  type CodeGraph,
  type CodeGraphNodeData,
  type ImportEdgeData,
  type SymbolNodeData,
} from "./buildDefinitionGraph.js";

export type AnalysisDiagnosticKind =
  | "compiler"
  | "unresolved-import"
  | "external-import"
  | "unresolved-call"
  | "unindexed-target"
  | "ambiguous-call";

export interface AnalysisDiagnostic {
  readonly kind: AnalysisDiagnosticKind;
  readonly message: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
}

export interface ProjectAnalysis {
  readonly rootDirectory: string;
  readonly graph: CodeGraph;
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly fileHashes: Readonly<Record<string, string>>;
}

export async function analyzeProject(
  rootDirectory: string,
): Promise<ProjectAnalysis> {
  const absoluteRoot = path.resolve(rootDirectory);
  const relativeFiles = await discoverSourceFiles(absoluteRoot);
  const rootNames = relativeFiles.map((file) => path.join(absoluteRoot, file));
  const fileHashes = await hashSourceFiles(absoluteRoot, relativeFiles);
  const compilerOptions = readCompilerOptions(absoluteRoot);
  const program = ts.createProgram({ rootNames, options: compilerOptions });
  const checker = program.getTypeChecker();
  const projectFilesByCanonicalName = new Map<string, ts.SourceFile>();

  for (const sourceFile of program.getSourceFiles()) {
    const canonicalName = canonicalPath(sourceFile.fileName);
    if (rootNames.some((rootName) => canonicalPath(rootName) === canonicalName)) {
      projectFilesByCanonicalName.set(canonicalName, sourceFile);
    }
  }

  const sourceFiles = [...projectFilesByCanonicalName.values()];
  const filePathFor = (sourceFile: ts.SourceFile): string =>
    toProjectPath(absoluteRoot, sourceFile.fileName);
  const graph = buildDefinitionGraph(sourceFiles, {
    getFilePath: filePathFor,
  });
  const diagnostics: AnalysisDiagnostic[] = compilerDiagnostics(
    program,
    absoluteRoot,
  );
  const symbolNodesByLocation = indexSymbolNodesByLocation(graph);

  addImportEdges(
    graph,
    sourceFiles,
    projectFilesByCanonicalName,
    compilerOptions,
    absoluteRoot,
    diagnostics,
  );
  addCallEdges(
    graph,
    sourceFiles,
    checker,
    symbolNodesByLocation,
    absoluteRoot,
    diagnostics,
  );

  return { rootDirectory: absoluteRoot, graph, diagnostics, fileHashes };
}

async function hashSourceFiles(
  rootDirectory: string,
  relativeFiles: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all(
    relativeFiles.map(async (filePath) => {
      const contents = await readFile(path.join(rootDirectory, filePath));
      return [filePath, createHash("sha256").update(contents).digest("hex")] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function readCompilerOptions(rootDirectory: string): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
  };
  const configPath = ts.findConfigFile(rootDirectory, ts.sys.fileExists);

  if (configPath === undefined) {
    return defaults;
  }

  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error !== undefined) {
    throw new Error(formatDiagnostic(loaded.error, rootDirectory));
  }

  // Passing the config file name sets `configFilePath`, so automatic @types
  // resolve from the project rather than from the process working directory.
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );

  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => formatDiagnostic(error, rootDirectory)).join("\n"));
  }

  return { ...defaults, ...parsed.options };
}

function addImportEdges(
  graph: CodeGraph,
  sourceFiles: readonly ts.SourceFile[],
  projectFilesByCanonicalName: ReadonlyMap<string, ts.SourceFile>,
  compilerOptions: ts.CompilerOptions,
  rootDirectory: string,
  diagnostics: AnalysisDiagnostic[],
): void {
  for (const sourceFile of sourceFiles) {
    const sourcePath = toProjectPath(rootDirectory, sourceFile.fileName);
    const sourceId = createFileNodeId(sourcePath);

    for (const statement of sourceFile.statements) {
      const moduleReference = getModuleReference(statement);
      if (moduleReference === null) {
        continue;
      }

      const resolved = ts.resolveModuleName(
        moduleReference.specifier,
        sourceFile.fileName,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      const location = locationFor(sourceFile, moduleReference.node, sourcePath);

      if (resolved === undefined) {
        if (!isRelativeModuleSpecifier(moduleReference.specifier)) {
          continue;
        }
        diagnostics.push({
          kind: "unresolved-import",
          message: `Could not resolve module '${moduleReference.specifier}'`,
          ...location,
        });
        continue;
      }

      const targetFile = projectFilesByCanonicalName.get(
        canonicalPath(resolved.resolvedFileName),
      );
      if (targetFile === undefined) {
        continue;
      }

      const targetId = createFileNodeId(
        toProjectPath(rootDirectory, targetFile.fileName),
      );
      if (graph.hasEdge(sourceId, targetId, "IMPORTS")) {
        continue;
      }

      const data: ImportEdgeData = {
        relationship: "IMPORTS",
        confidence: "exact",
        provenance: "typescript-module-resolution",
        moduleSpecifier: moduleReference.specifier,
        importKind: moduleReference.kind,
      };
      graph.addEdge({ from: sourceId, to: targetId, type: "IMPORTS", data });
    }
  }
}

interface ModuleReference {
  readonly node: ts.StringLiteral;
  readonly specifier: string;
  readonly kind: ImportEdgeData["importKind"];
}

function getModuleReference(statement: ts.Statement): ModuleReference | null {
  if (
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return {
      node: statement.moduleSpecifier,
      specifier: statement.moduleSpecifier.text,
      kind: "re-export",
    };
  }

  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return null;
  }

  const clause = statement.importClause;
  let kind: ImportEdgeData["importKind"];
  if (clause === undefined) {
    kind = "side-effect";
  } else if (clause.name !== undefined && clause.namedBindings !== undefined) {
    kind = "mixed";
  } else if (clause.name !== undefined) {
    kind = "default";
  } else if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
    kind = "namespace";
  } else {
    kind = "named";
  }

  return {
    node: statement.moduleSpecifier,
    specifier: statement.moduleSpecifier.text,
    kind,
  };
}

function addCallEdges(
  graph: CodeGraph,
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  symbolNodesByLocation: ReadonlyMap<string, GraphNode<SymbolNodeData>>,
  rootDirectory: string,
  diagnostics: AnalysisDiagnostic[],
): void {
  for (const sourceFile of sourceFiles) {
    const filePath = toProjectPath(rootDirectory, sourceFile.fileName);

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        addCallEdge(
          node,
          sourceFile,
          filePath,
          graph,
          checker,
          symbolNodesByLocation,
          rootDirectory,
          diagnostics,
        );
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }
}

function addCallEdge(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  graph: CodeGraph,
  checker: ts.TypeChecker,
  symbolNodesByLocation: ReadonlyMap<string, GraphNode<SymbolNodeData>>,
  rootDirectory: string,
  diagnostics: AnalysisDiagnostic[],
): void {
  const callLocation = locationFor(sourceFile, call.expression, filePath);
  const signatureDeclarations = resolvedSignatureDeclarations(call, checker);
  let targets = mapIndexedTargets(
    signatureDeclarations,
    graph,
    symbolNodesByLocation,
    rootDirectory,
  );
  // A signature can come from a type (`const handler: Handler = ...`) rather
  // than from the callee itself; the callee's symbol is the better target then.
  let hasAnyDeclaration = signatureDeclarations.length > 0;
  if (targets.ids.size === 0) {
    const symbolDeclarations = resolvedSymbolDeclarations(call, checker);
    if (symbolDeclarations.length > 0) {
      hasAnyDeclaration = true;
      const fromSymbol = mapIndexedTargets(
        symbolDeclarations,
        graph,
        symbolNodesByLocation,
        rootDirectory,
      );
      targets = {
        ids: fromSymbol.ids,
        hasInternalTarget: targets.hasInternalTarget || fromSymbol.hasInternalTarget,
      };
    }
  }
  const targetIds = targets.ids;

  if (targetIds.size === 0) {
    if (hasAnyDeclaration && !targets.hasInternalTarget) {
      return;
    }
    diagnostics.push({
      kind: hasAnyDeclaration ? "unindexed-target" : "unresolved-call",
      message: `Could not map call '${call.expression.getText(sourceFile)}' to an indexed declaration`,
      ...callLocation,
    });
    return;
  }

  if (targetIds.size > 1) {
    diagnostics.push({
      kind: "ambiguous-call",
      message: `Call '${call.expression.getText(sourceFile)}' has ${targetIds.size} possible indexed targets`,
      ...callLocation,
    });
    return;
  }

  const callerId = findCallerNodeId(call, sourceFile, filePath, symbolNodesByLocation);

  const target = [...targetIds.entries()][0];
  if (target === undefined) {
    return;
  }
  const [targetId, declaration] = target;
  if (graph.hasEdge(callerId, targetId, "CALLS")) {
    return;
  }

  const data: CallEdgeData = {
    relationship: "CALLS",
    confidence: ts.isMethodSignature(declaration) ? "inferred" : "exact",
    provenance: "typescript-type-checker",
    location: {
      file: filePath,
      line: callLocation.line ?? 1,
      column: callLocation.column ?? 1,
    },
  };
  graph.addEdge({ from: callerId, to: targetId, type: "CALLS", data });
}

interface IndexedTargets {
  readonly ids: ReadonlyMap<string, ts.Declaration>;
  readonly hasInternalTarget: boolean;
}

function mapIndexedTargets(
  declarations: readonly ts.Declaration[],
  graph: CodeGraph,
  symbolNodesByLocation: ReadonlyMap<string, GraphNode<SymbolNodeData>>,
  rootDirectory: string,
): IndexedTargets {
  const ids = new Map<string, ts.Declaration>();
  let hasInternalTarget = false;

  for (const declaration of declarations) {
    const name = declarationNameNode(declaration);
    const targetSourceFile = declaration.getSourceFile();
    if (!isInsideRoot(rootDirectory, targetSourceFile.fileName)) {
      continue;
    }
    const targetPath = toProjectPath(rootDirectory, targetSourceFile.fileName);
    if (graph.getNode(createFileNodeId(targetPath)) === undefined) {
      continue;
    }
    hasInternalTarget = true;
    if (name === undefined) {
      continue;
    }
    const targetId = symbolNodesByLocation.get(
      nodeLocationKey(targetSourceFile, name, targetPath),
    )?.id;
    if (targetId !== undefined) {
      ids.set(targetId, declaration);
    }
  }

  return { ids, hasInternalTarget };
}

function resolvedSignatureDeclarations(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): readonly ts.Declaration[] {
  const signatureDeclaration = checker.getResolvedSignature(call)?.declaration;
  return signatureDeclaration === undefined ? [] : [signatureDeclaration];
}

function resolvedSymbolDeclarations(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): readonly ts.Declaration[] {
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (symbol === undefined && ts.isPropertyAccessExpression(call.expression)) {
    symbol = checker.getSymbolAtLocation(call.expression.name);
  }
  if (symbol === undefined) {
    return [];
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol.declarations ?? [];
}

/**
 * Attributes a call to the nearest enclosing indexed declaration. Anonymous
 * callbacks (`.map(x => ...)`, `it("...", () => ...)`) are transparent, and a
 * call with no indexed declaration around it belongs to its file, which is
 * what runs it when the module is loaded.
 */
function findCallerNodeId(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  symbolNodesByLocation: ReadonlyMap<string, GraphNode<SymbolNodeData>>,
): string {
  let current: ts.Node | undefined = call.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    const name = callerNameNode(current);
    if (name !== undefined) {
      const callerId = symbolNodesByLocation.get(
        nodeLocationKey(sourceFile, name, filePath),
      )?.id;
      if (callerId !== undefined) {
        return callerId;
      }
    }
    current = current.parent;
  }
  return createFileNodeId(filePath);
}

function callerNameNode(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node)
  ) {
    return node.name;
  }
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
    node.initializer !== undefined &&
    isFunctionInitializer(node.initializer)
  ) {
    return node.name;
  }
  return undefined;
}

function declarationNameNode(declaration: ts.Declaration): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration)
  ) {
    return declaration.name;
  }
  // Signatures of `const f = () => {}` resolve to the function expression;
  // the indexed symbol sits on the variable or class field that holds it.
  if (
    (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) &&
    (ts.isVariableDeclaration(declaration.parent) ||
      ts.isPropertyDeclaration(declaration.parent)) &&
    declaration.parent.initializer === declaration
  ) {
    return declaration.parent.name;
  }
  if (
    (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) &&
    declaration.initializer !== undefined &&
    isFunctionInitializer(declaration.initializer)
  ) {
    return declaration.name;
  }
  return undefined;
}

function indexSymbolNodesByLocation(
  graph: CodeGraph,
): ReadonlyMap<string, GraphNode<SymbolNodeData>> {
  const result = new Map<string, GraphNode<SymbolNodeData>>();
  for (const node of graph.getNodes()) {
    if (node.data.nodeType === "symbol") {
      result.set(
        locationKey(node.data.location.file, node.data.location.line, node.data.location.column),
        node as GraphNode<SymbolNodeData>,
      );
    }
  }
  return result;
}

function nodeLocationKey(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  filePath: string,
): string {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return locationKey(filePath, position.line + 1, position.character + 1);
}

function locationKey(file: string, line: number, column: number): string {
  return `${file}:${line}:${column}`;
}

function locationFor(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  filePath: string,
): Pick<AnalysisDiagnostic, "file" | "line" | "column"> {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: filePath, line: position.line + 1, column: position.character + 1 };
}

function compilerDiagnostics(
  program: ts.Program,
  rootDirectory: string,
): AnalysisDiagnostic[] {
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      return {
        kind: "compiler" as const,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        file: null,
        line: null,
        column: null,
      };
    }
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return {
      kind: "compiler" as const,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      file: toProjectPath(rootDirectory, diagnostic.file.fileName),
      line: position.line + 1,
      column: position.character + 1,
    };
  });
}

function formatDiagnostic(diagnostic: ts.Diagnostic, rootDirectory: string): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return message;
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${toProjectPath(rootDirectory, diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1} ${message}`;
}

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

function isRelativeModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function isInsideRoot(rootDirectory: string, filePath: string): boolean {
  const relative = path.relative(rootDirectory, filePath);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function toProjectPath(rootDirectory: string, filePath: string): string {
  return path.relative(rootDirectory, filePath).split(path.sep).join("/");
}
