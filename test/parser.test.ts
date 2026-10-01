import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ts from "typescript";

import { extractDeclarations, parseSourceFile } from "../src/index.js";

describe("parseSourceFile", () => {
  it("creates a SourceFile AST with function syntax", () => {
    const sourceFile = parseSourceFile(
      "greeting.ts",
      "function hello(name: string) { return name; }",
    );
    const statement = sourceFile.statements[0];

    assert.equal(sourceFile.kind, ts.SyntaxKind.SourceFile);
    assert.ok(statement !== undefined);
    assert.ok(ts.isFunctionDeclaration(statement));
    assert.equal(statement.name?.text, "hello");
  });

  it("parses TSX using the TSX script kind", () => {
    const sourceFile = parseSourceFile(
      "Button.tsx",
      "const button = <button>Save</button>;",
    );
    let foundJsxElement = false;

    function visit(node: ts.Node): void {
      if (ts.isJsxElement(node)) {
        foundJsxElement = true;
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    assert.equal(foundJsxElement, true);
  });
});

describe("extractDeclarations", () => {
  it("extracts functions, classes, interfaces, and methods", () => {
    const sourceFile = parseSourceFile(
      "src/example.ts",
      [
        "export function greet(name: string) {}",
        "",
        "export interface UserRepository {",
        "  findUser(id: string): string;",
        "}",
        "",
        "export class UserService {",
        "  getUser(id: string) {}",
        "  private validate() {}",
        "}",
      ].join("\n"),
    );

    const declarations = extractDeclarations(sourceFile);

    assert.deepEqual(
      declarations.map(({ kind, qualifiedName }) => ({ kind, qualifiedName })),
      [
        { kind: "function", qualifiedName: "greet" },
        { kind: "interface", qualifiedName: "UserRepository" },
        { kind: "method", qualifiedName: "UserRepository.findUser" },
        { kind: "class", qualifiedName: "UserService" },
        { kind: "method", qualifiedName: "UserService.getUser" },
        { kind: "method", qualifiedName: "UserService.validate" },
      ],
    );
  });

  it("reports one-based source locations at declaration names", () => {
    const sourceFile = parseSourceFile(
      "src/math.ts",
      "\n  function add(left: number, right: number) {}",
    );

    assert.deepEqual(extractDeclarations(sourceFile), [
      {
        kind: "function",
        name: "add",
        qualifiedName: "add",
        location: {
          file: "src/math.ts",
          line: 2,
          column: 12,
        },
      },
    ]);
  });

  it("ignores anonymous declarations that cannot be named", () => {
    const sourceFile = parseSourceFile(
      "src/anonymous.ts",
      "export default class { run() {} }",
    );

    assert.deepEqual(extractDeclarations(sourceFile), []);
  });
});
