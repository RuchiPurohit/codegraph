import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const TEST_DIRECTORY_NAMES = new Set(["__mocks__", "__tests__", "test", "tests"]);
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

export interface DiscoverSourceFilesOptions {
  /** Leaves out test files and test-only directories (see `isTestFile`). */
  readonly excludeTests?: boolean;
}

/**
 * Finds TypeScript source files below `rootDirectory`.
 *
 * Results are sorted, root-relative, and use forward slashes so they are
 * stable across operating systems. Symbolic links are deliberately ignored.
 */
export async function discoverSourceFiles(
  rootDirectory: string,
  options: DiscoverSourceFilesOptions = {},
): Promise<readonly string[]> {
  const absoluteRoot = path.resolve(rootDirectory);
  const sourceFiles: string[] = [];

  await visitDirectory(absoluteRoot, absoluteRoot, sourceFiles);

  return sourceFiles
    .filter((file) => options.excludeTests !== true || !isTestFile(file))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * True for `*.test.ts(x)` / `*.spec.ts(x)` files and for anything below a
 * `__tests__`, `__mocks__`, `test` or `tests` directory, which is where test
 * helpers (fixtures, seeders, app factories) conventionally live.
 */
export function isTestFile(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const fileName = segments.pop() ?? "";
  return TEST_FILE_PATTERN.test(fileName) ||
    segments.some((segment) => TEST_DIRECTORY_NAMES.has(segment));
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
