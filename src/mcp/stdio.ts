#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createCodeGraphMcpServer } from "./server.js";

export async function runCodeGraphMcpServer(
  arguments_: readonly string[],
): Promise<void> {
  const rootDirectory = optionValue(arguments_, "--root") ?? process.cwd();
  const indexPath = optionValue(arguments_, "--index");
  const server = createCodeGraphMcpServer({
    rootDirectory,
    ...(indexPath === undefined ? {} : { indexPath }),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function optionValue(
  arguments_: readonly string[],
  option: string,
): string | undefined {
  const index = arguments_.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  runCodeGraphMcpServer(process.argv.slice(2)).catch((error: unknown) => {
    // stdout is reserved for MCP protocol messages when using stdio.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
