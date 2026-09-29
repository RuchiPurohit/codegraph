import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

/**
 * Finds TypeScript source files below `rootDirectory`.
 *
 * Results are sorted, root-relative, and use forward slashes so they are
 * stable across operating systems. Symbolic links are deliberately ignored.
 */
export async function discoverSourceFiles(
  rootDirectory: string,
): Promise<readonly string[]> {
  const absoluteRoot = path.resolve(rootDirectory);
  const sourceFiles: string[] = [];

  await visitDirectory(absoluteRoot, absoluteRoot, sourceFiles);

  return sourceFiles.sort((left, right) => left.localeCompare(right));
}

async function visitDirectory(
  absoluteRoot: string,
  currentDirectory: string,
  sourceFiles: string[],
): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        await visitDirectory(absoluteRoot, absolutePath, sourceFiles);
      }

      continue;
    }

    if (entry.isFile() && isTypeScriptSourceFile(entry.name)) {
      sourceFiles.push(toPortableRelativePath(absoluteRoot, absolutePath));
    }
  }
}

function isTypeScriptSourceFile(fileName: string): boolean {
  if (fileName.endsWith(".d.ts")) {
    return false;
  }

  return fileName.endsWith(".ts") || fileName.endsWith(".tsx");
}

function toPortableRelativePath(
  absoluteRoot: string,
  absolutePath: string,
): string {
  return path.relative(absoluteRoot, absolutePath).split(path.sep).join("/");
}
