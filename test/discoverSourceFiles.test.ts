import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { discoverSourceFiles } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codegraph-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(root: string, relativePath: string): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("discoverSourceFiles", () => {
  it("finds nested TypeScript and TSX files in deterministic order", async () => {
    const root = await createTemporaryDirectory();
    await createFile(root, "src/zebra.ts");
    await createFile(root, "src/components/Button.tsx");
    await createFile(root, "alpha.ts");

    const files = await discoverSourceFiles(root);

    assert.deepEqual(files, [
      "alpha.ts",
      "src/components/Button.tsx",
      "src/zebra.ts",
    ]);
  });

  it("ignores generated and metadata directories at any depth", async () => {
    const root = await createTemporaryDirectory();
    await createFile(root, "src/kept.ts");
    await createFile(root, "node_modules/package/index.ts");
    await createFile(root, ".git/hooks/example.ts");
    await createFile(root, "dist/output.ts");
    await createFile(root, "packages/app/build/output.tsx");
    await createFile(root, "packages/app/coverage/report.ts");

    assert.deepEqual(await discoverSourceFiles(root), ["src/kept.ts"]);
  });

  it("excludes declaration files and unrelated extensions", async () => {
    const root = await createTemporaryDirectory();
    await createFile(root, "src/index.ts");
    await createFile(root, "src/index.d.ts");
    await createFile(root, "src/index.js");
    await createFile(root, "src/styles.css");

    assert.deepEqual(await discoverSourceFiles(root), ["src/index.ts"]);
  });

  it("does not follow symbolic links", async () => {
    const root = await createTemporaryDirectory();
    const externalDirectory = await createTemporaryDirectory();
    await createFile(root, "src/kept.ts");
    await createFile(externalDirectory, "linked.ts");
    await symlink(externalDirectory, path.join(root, "linked-source"));

    assert.deepEqual(await discoverSourceFiles(root), ["src/kept.ts"]);
  });

  it("returns an empty list when no source files exist", async () => {
    const root = await createTemporaryDirectory();
    await createFile(root, "README.md");

    assert.deepEqual(await discoverSourceFiles(root), []);
  });

  it("preserves the filesystem error for a nonexistent root", async () => {
    const root = await createTemporaryDirectory();
    const missingRoot = path.join(root, "missing");

    await assert.rejects(discoverSourceFiles(missingRoot), {
      code: "ENOENT",
    });
  });
});
