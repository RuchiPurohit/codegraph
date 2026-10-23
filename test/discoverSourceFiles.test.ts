import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { discoverSourceFiles, isTestFile } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeskope-"));
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

  it("leaves out test files and test directories only when asked", async () => {
    const root = await createTemporaryDirectory();
    await createFile(root, "src/service.ts");
    await createFile(root, "src/service.test.ts");
    await createFile(root, "src/Button.spec.tsx");
    await createFile(root, "src/__tests__/service.ts");
    await createFile(root, "src/test/db.ts");
    await createFile(root, "test/helpers.ts");
    await createFile(root, "src/testing.ts");

    assert.equal((await discoverSourceFiles(root)).length, 7);
    assert.deepEqual(await discoverSourceFiles(root, { excludeTests: true }), [
      "src/service.ts",
      "src/testing.ts",
    ]);
  });

  it("recognises test files by name and by directory segment", () => {
    for (const file of [
      "a.test.ts",
      "src/a.spec.tsx",
      "src/__tests__/a.ts",
      "src/__mocks__/a.ts",
      "src/test/a.ts",
      "tests/a.ts",
    ]) {
      assert.equal(isTestFile(file), true, file);
    }
    for (const file of ["src/a.ts", "src/testing.ts", "src/contest/a.ts", "src/latest.ts"]) {
      assert.equal(isTestFile(file), false, file);
    }
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
