import { access } from "node:fs/promises";
import path from "node:path";

import {
  analyzeProject,
  type AnalyzeProjectOptions,
  type ProjectAnalysis,
} from "../analyzer/analyzeProject.js";
import {
  defaultIndexPath,
  type FileChanges,
  type IncrementalUpdateResult,
  updateProjectIndex,
} from "../analyzer/incrementalIndex.js";
import {
  loadProjectAnalysis,
  saveProjectAnalysis,
} from "../persistence/jsonPersistence.js";

export type RefreshMode = "incremental" | "full";

/** Maintains one project-scoped graph for the lifetime of an MCP connection. */
export class CodeGraphProjectSession {
  readonly rootDirectory: string;
  readonly indexPath: string;
  readonly analyzeOptions: AnalyzeProjectOptions;
  private currentAnalysis: ProjectAnalysis | undefined;

  constructor(
    rootDirectory: string,
    indexPath?: string,
    analyzeOptions: AnalyzeProjectOptions = {},
  ) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.analyzeOptions = analyzeOptions;
    this.indexPath = path.resolve(
      indexPath ?? defaultIndexPath(this.rootDirectory),
    );
  }

  /**
   * Builds a fresh in-memory snapshot on first use. The server deliberately
   * avoids trusting a possibly stale persisted index without an explicit
   * refresh request.
   */
  async getAnalysis(): Promise<ProjectAnalysis> {
    if (this.currentAnalysis === undefined) {
      this.currentAnalysis = await analyzeProject(
        this.rootDirectory,
        this.analyzeOptions,
      );
    }
    return this.currentAnalysis;
  }

  async refresh(mode: RefreshMode): Promise<IncrementalUpdateResult> {
    if (mode === "incremental" && await fileExists(this.indexPath)) {
      const result = await updateProjectIndex(
        this.indexPath,
        this.rootDirectory,
        this.analyzeOptions,
      );
      this.currentAnalysis = result.analysis;
      return result;
    }

    const previous = this.currentAnalysis ?? await loadIfPresent(this.indexPath);
    const analysis = await analyzeProject(this.rootDirectory, this.analyzeOptions);
    await saveProjectAnalysis(analysis, this.indexPath);
    this.currentAnalysis = analysis;

    return {
      analysis,
      files: compareFileHashes(previous?.fileHashes ?? {}, analysis.fileHashes),
    };
  }
}

async function loadIfPresent(
  indexPath: string,
): Promise<ProjectAnalysis | undefined> {
  if (!await fileExists(indexPath)) {
    return undefined;
  }
  return loadProjectAnalysis(indexPath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function compareFileHashes(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): FileChanges {
  const previousPaths = new Set(Object.keys(previous));
  const currentPaths = new Set(Object.keys(current));
  const added = [...currentPaths]
    .filter((filePath) => !previousPaths.has(filePath))
    .sort();
  const changed = [...currentPaths]
    .filter(
      (filePath) =>
        previousPaths.has(filePath) &&
        previous[filePath] !== current[filePath],
    )
    .sort();
  const deleted = [...previousPaths]
    .filter((filePath) => !currentPaths.has(filePath))
    .sort();
  const affected = [...new Set([...added, ...changed, ...deleted])].sort();

  return {
    added,
    changed,
    deleted,
    affected,
    reused: [...currentPaths]
      .filter((filePath) => !affected.includes(filePath))
      .sort(),
  };
}
