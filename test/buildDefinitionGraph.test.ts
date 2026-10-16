import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDefinitionGraph,
  createFileNodeId,
  createSymbolNodeId,
  parseSourceFile,
} from "../src/index.js";

describe("buildDefinitionGraph", () => {
  it("connects a file to its top-level declarations", () => {
    const sourceFile = parseSourceFile(
      "src/user.ts",
      [
        "export function createUser() {}",
        "export interface UserRepository {}",
        "export class UserService {}",
      ].join("\n"),
    );
    const graph = buildDefinitionGraph([sourceFile]);

    assert.deepEqual(
      graph
        .getDependencies(createFileNodeId("src/user.ts"))
        .map((node) => node.id),
      [
        createSymbolNodeId("src/user.ts", "createUser"),
        createSymbolNodeId("src/user.ts", "UserRepository"),
        createSymbolNodeId("src/user.ts", "UserService"),
      ],
    );
  });

  it("connects classes and interfaces to their methods", () => {
    const sourceFile = parseSourceFile(
      "src/user.ts",
      [
        "interface UserRepository {",
        "  findUser(id: string): string;",
        "}",
        "class UserService {",
        "  getUser(id: string) {}",
        "}",
      ].join("\n"),
    );
    const graph = buildDefinitionGraph([sourceFile]);

    assert.deepEqual(
      graph
        .getDependencies(
          createSymbolNodeId("src/user.ts", "UserRepository"),
        )
        .map((node) => node.id),
      [createSymbolNodeId("src/user.ts", "UserRepository.findUser")],
    );
    assert.deepEqual(
      graph
        .getDependencies(createSymbolNodeId("src/user.ts", "UserService"))
        .map((node) => node.id),
      [createSymbolNodeId("src/user.ts", "UserService.getUser")],
    );
  });

  it("keeps same-named symbols in different files separate", () => {
    const graph = buildDefinitionGraph([
      parseSourceFile("src/json.ts", "export function parse() {}"),
      parseSourceFile("src/query.ts", "export function parse() {}"),
    ]);
    const jsonParseId = createSymbolNodeId("src/json.ts", "parse");
    const queryParseId = createSymbolNodeId("src/query.ts", "parse");

    assert.notEqual(jsonParseId, queryParseId);
    assert.ok(graph.getNode(jsonParseId));
    assert.ok(graph.getNode(queryParseId));
  });

  it("stores declaration metadata in symbol node data", () => {
    const graph = buildDefinitionGraph([
      parseSourceFile("src/math.ts", "export function add() {}"),
    ]);
    const node = graph.getNode(createSymbolNodeId("src/math.ts", "add"));

    assert.ok(node);
    assert.equal(node.data.nodeType, "symbol");

    if (node.data.nodeType === "symbol") {
      assert.equal(node.data.declarationKind, "function");
      assert.equal(node.data.qualifiedName, "add");
      assert.equal(node.data.location.file, "src/math.ts");
      assert.equal(node.data.location.line, 1);
    }
  });

  it("creates one DEFINES edge for each declaration", () => {
    const graph = buildDefinitionGraph([
      parseSourceFile(
        "src/user.ts",
        [
          "function helper() {}",
          "class UserService {",
          "  getUser() {}",
          "}",
        ].join("\n"),
      ),
    ]);

    assert.equal(graph.nodeCount, 4);
    assert.equal(graph.edgeCount, 3);
  });
});
