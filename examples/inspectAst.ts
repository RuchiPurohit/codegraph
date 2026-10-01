import ts from "typescript";

import { parseSourceFile } from "../src/index.js";

const sourceFile = parseSourceFile(
  "example.ts",
  `
function hello(name: string) {
  return \`Hello \${name}\`;
}

class UserService {
  findUser(id: string) {}
}
`,
);

function printNode(node: ts.Node, depth = 0): void {
  const indentation = "  ".repeat(depth);
  console.log(`${indentation}${ts.SyntaxKind[node.kind]}`);

  ts.forEachChild(node, (child) => printNode(child, depth + 1));
}

printNode(sourceFile);
