import { readFileSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  CodeGraph,
  CodeGraphEdgeData,
  CodeGraphEdgeType,
  CodeGraphNodeData,
} from "../analyzer/buildDefinitionGraph.js";
import { analyzeDiffImpact, readGitDiff } from "../git/diffImpact.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { DeclarationKind } from "../parser/extractDeclarations.js";
import { analyzeImpact, type ImpactResult } from "../queries/analyzeImpact.js";
import { findSymbols } from "../queries/codeGraphQueries.js";
import {
  CodeGraphProjectSession,
  type RefreshMode,
} from "./projectSession.js";

// Resolves to the package root from both src/mcp and dist/mcp.
const SERVER_VERSION = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const DEFAULT_PATH_DEPTH = 10;
const MAX_PATH_DEPTH = 50;
const DEFAULT_IMPACT_DEPTH = 5;
const DEFAULT_IMPACT_RESULTS = 50;
const MAX_FILE_RESULTS = 100;

const declarationKindSchema = z.enum([
  "function",
  "class",
  "interface",
  "method",
]);
const relationshipTypeSchema = z.enum(["CALLS", "IMPORTS"]);
const relationshipTypesInput = z
  .array(relationshipTypeSchema)
  .min(1)
  .max(2)
  .optional();
const limitInput = z.number().int().min(1).max(MAX_LIST_LIMIT).optional();

const sourceSummarySchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive().nullable(),
  startColumn: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  endColumn: z.number().int().positive().nullable(),
});

const entitySummarySchema = z.object({
  id: z.string(),
  type: z.enum(["file", "symbol"]),
  name: z.string().nullable(),
  qualifiedName: z.string().nullable(),
  declarationKind: declarationKindSchema.nullable(),
  source: sourceSummarySchema,
});

const relationshipSummarySchema = z.object({
  type: relationshipTypeSchema,
  confidence: z.enum(["exact", "inferred"]),
  provenance: z.enum([
    "typescript-type-checker",
    "typescript-module-resolution",
  ]),
  moduleSpecifier: z.string().nullable(),
  source: z
    .object({
      path: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
    })
    .nullable(),
});

const relationshipResultSchema = z.object({
  entity: entitySummarySchema,
  relationship: relationshipSummarySchema,
});

const impactSummarySchema = z.object({
  changed: entitySummarySchema,
  directDependents: z.array(entitySummarySchema),
  indirectDependents: z.array(entitySummarySchema),
  affectedFiles: z.array(z.string()),
  counts: z.object({
    direct: z.number().int().nonnegative(),
    indirect: z.number().int().nonnegative(),
    affectedFiles: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export interface CodeGraphMcpServerOptions {
  readonly rootDirectory?: string;
  readonly indexPath?: string;
}

export interface EntitySummary {
  readonly id: string;
  readonly type: "file" | "symbol";
  readonly name: string | null;
  readonly qualifiedName: string | null;
  readonly declarationKind: DeclarationKind | null;
  readonly source: {
    readonly path: string;
    readonly startLine: number | null;
    readonly startColumn: number | null;
    readonly endLine: number | null;
    readonly endColumn: number | null;
  };
}

interface RelationshipSummary {
  readonly type: "CALLS" | "IMPORTS";
  readonly confidence: "exact" | "inferred";
  readonly provenance:
    | "typescript-type-checker"
    | "typescript-module-resolution";
  readonly moduleSpecifier: string | null;
  readonly source: {
    readonly path: string;
    readonly line: number;
    readonly column: number;
  } | null;
}

interface PathEntry {
  readonly entity: EntitySummary;
  readonly via: RelationshipSummary | null;
}

/** Creates one project-scoped MCP server. Callers choose the transport. */
export function createCodeGraphMcpServer(
  options: CodeGraphMcpServerOptions = {},
): McpServer {
  const session = new CodeGraphProjectSession(
    options.rootDirectory ?? process.cwd(),
    options.indexPath,
  );
  const server = new McpServer(
    { name: "codeskope", version: SERVER_VERSION },
    {
      instructions: [
        "Use find_symbol before relationship tools so names resolve to stable node IDs.",
        "Results are bounded and source-linked; read only the reported source ranges.",
        "Call refresh_index after source files change, then analyze_diff to review blast radius.",
      ].join(" "),
      maxToolInputElements: 100,
    },
  );

  server.registerTool(
    "find_symbol",
    {
      title: "Find symbol",
      description:
        "Find TypeScript declarations by name or qualified name. Use this first to obtain stable node IDs and source ranges for follow-up graph queries.",
      inputSchema: {
        query: z.string().trim().min(1).max(300),
        kinds: z.array(declarationKindSchema).min(1).max(4).optional(),
        file: z.string().trim().min(1).optional(),
        limit: limitInput,
      },
      outputSchema: {
        matches: z.array(entitySummarySchema),
        totalMatches: z.number().int().nonnegative(),
        truncated: z.boolean(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, kinds, file, limit }) => {
      const analysis = await session.getAnalysis();
      const kindSet = kinds === undefined
        ? undefined
        : new Set<DeclarationKind>(kinds);
      const filtered = findSymbols(analysis.graph, query).filter(
        (node) =>
          (kindSet === undefined || kindSet.has(node.data.declarationKind)) &&
          (file === undefined || node.data.location.file === file),
      );
      const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
      const matches = filtered
        .slice(0, effectiveLimit)
        .map(toEntitySummary);
      const structuredContent = {
        matches,
        totalMatches: filtered.length,
        truncated: filtered.length > matches.length,
      };
      return toolResult(
        `Found ${filtered.length} matching symbol${filtered.length === 1 ? "" : "s"}; returned ${matches.length}.`,
        structuredContent,
      );
    },
  );

  registerRelationshipTool(
    server,
    session,
    "get_dependencies",
    "Get dependencies",
    "Follow outgoing CALLS or IMPORTS relationships from a node. Use this to learn what a symbol or file relies on before reading or changing it.",
    "outgoing",
  );
  registerRelationshipTool(
    server,
    session,
    "get_dependents",
    "Get dependents",
    "Follow incoming CALLS or IMPORTS relationships to a node. Use this to find immediate callers or importers before changing shared code.",
    "incoming",
  );

  server.registerTool(
    "find_path",
    {
      title: "Find dependency path",
      description:
        "Find a minimum-edge CALLS or IMPORTS path between two stable node IDs. Use this to explain how two code entities are connected without loading the whole graph.",
      inputSchema: {
        fromNodeId: z.string().min(1),
        toNodeId: z.string().min(1),
        relationships: relationshipTypesInput,
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(MAX_PATH_DEPTH)
          .optional(),
      },
      outputSchema: {
        found: z.boolean(),
        path: z.array(
          z.object({
            entity: entitySummarySchema,
            via: relationshipSummarySchema.nullable(),
          }),
        ),
        edgeCount: z.number().int().nonnegative().nullable(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ fromNodeId, toNodeId, relationships, maxDepth }) => {
      const analysis = await session.getAnalysis();
      const pathEntries = findBoundedPath(
        analysis.graph,
        fromNodeId,
        toNodeId,
        relationships ?? ["CALLS", "IMPORTS"],
        maxDepth ?? DEFAULT_PATH_DEPTH,
      );
      const structuredContent = {
        found: pathEntries !== null,
        path: pathEntries ?? [],
        edgeCount: pathEntries === null ? null : pathEntries.length - 1,
      };
      return toolResult(
        pathEntries === null
          ? "No dependency path was found within the requested depth."
          : `Found a ${pathEntries.length - 1}-edge dependency path.`,
        structuredContent,
      );
    },
  );

  server.registerTool(
    "analyze_impact",
    {
      title: "Analyze symbol impact",
      description:
        "Calculate bounded reverse CALLS or IMPORTS impact for one stable node ID. Use this before changing shared code to identify direct and transitive dependents and affected files.",
      inputSchema: {
        nodeId: z.string().min(1),
        relationships: relationshipTypesInput,
        maxDepth: z.number().int().min(0).max(MAX_PATH_DEPTH).optional(),
        maxResults: limitInput,
      },
      outputSchema: impactSummarySchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ nodeId, relationships, maxDepth, maxResults }) => {
      const analysis = await session.getAnalysis();
      const impact = analyzeImpact(analysis.graph, nodeId, {
        maxDepth: maxDepth ?? DEFAULT_IMPACT_DEPTH,
        relationships: relationships ?? ["CALLS", "IMPORTS"],
      });
      const structuredContent = summarizeImpact(
        impact,
        maxResults ?? DEFAULT_IMPACT_RESULTS,
      );
      return toolResult(
        `Found ${structuredContent.counts.direct} direct and ${structuredContent.counts.indirect} indirect dependents across ${structuredContent.counts.affectedFiles} files.`,
        structuredContent,
      );
    },
  );

  server.registerTool(
    "analyze_diff",
    {
      title: "Analyze Git diff impact",
      description:
        "Map staged and unstaged tracked TypeScript changes relative to HEAD to enclosing symbols, then calculate bounded reverse impact. Use this after editing to guide review and testing.",
      inputSchema: {
        relationships: relationshipTypesInput,
        maxDepth: z.number().int().min(0).max(MAX_PATH_DEPTH).optional(),
        maxChangedSymbols: z.number().int().min(1).max(50).optional(),
        maxResultsPerSymbol: limitInput,
      },
      outputSchema: {
        changedSymbols: z.array(entitySummarySchema),
        impacts: z.array(impactSummarySchema),
        unmappedChanges: z.array(
          z.object({
            path: z.string(),
            line: z.number().int().nonnegative(),
          }),
        ),
        counts: z.object({
          changedSymbols: z.number().int().nonnegative(),
          affectedFiles: z.number().int().nonnegative(),
          unmappedChanges: z.number().int().nonnegative(),
        }),
        truncated: z.boolean(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      relationships,
      maxDepth,
      maxChangedSymbols,
      maxResultsPerSymbol,
    }) => {
      const analysis = await session.getAnalysis();
      const diffText = await readGitDiff(session.rootDirectory);
      const diff = analyzeDiffImpact(analysis.graph, diffText, {
        maxDepth: maxDepth ?? DEFAULT_IMPACT_DEPTH,
        relationships: relationships ?? ["CALLS", "IMPORTS"],
      });
      const symbolLimit = maxChangedSymbols ?? 20;
      const resultLimit = maxResultsPerSymbol ?? DEFAULT_IMPACT_RESULTS;
      const selectedImpacts = diff.impacts.slice(0, symbolLimit);
      const impacts = selectedImpacts.map((impact) =>
        summarizeImpact(impact, resultLimit)
      );
      const changedSymbols = diff.changedSymbols
        .slice(0, symbolLimit)
        .map(toEntitySummary);
      const affectedFiles = new Set(
        diff.impacts.flatMap((impact) => impact.affectedFiles),
      );
      const unmappedChanges = diff.unmappedLines
        .slice(0, MAX_FILE_RESULTS)
        .map((change) => ({ path: change.filePath, line: change.line }));
      const truncated =
        diff.changedSymbols.length > changedSymbols.length ||
        diff.unmappedLines.length > unmappedChanges.length ||
        impacts.some((impact) => impact.truncated);
      const structuredContent = {
        changedSymbols,
        impacts,
        unmappedChanges,
        counts: {
          changedSymbols: diff.changedSymbols.length,
          affectedFiles: affectedFiles.size,
          unmappedChanges: diff.unmappedLines.length,
        },
        truncated,
      };
      return toolResult(
        `Mapped ${diff.changedSymbols.length} changed symbol${diff.changedSymbols.length === 1 ? "" : "s"} affecting ${affectedFiles.size} file${affectedFiles.size === 1 ? "" : "s"}.`,
        structuredContent,
      );
    },
  );

  server.registerTool(
    "refresh_index",
    {
      title: "Refresh CodeGraph index",
      description:
        "Refresh the local project graph after source files change. Incremental mode reuses unaffected persisted graph data; full mode rebuilds and replaces the saved index.",
      inputSchema: {
        mode: z.enum(["incremental", "full"]).optional(),
      },
      outputSchema: {
        mode: z.enum(["incremental", "full"]),
        indexPath: z.string(),
        files: z.object({
          added: z.array(z.string()),
          changed: z.array(z.string()),
          deleted: z.array(z.string()),
          affected: z.array(z.string()),
          reusedCount: z.number().int().nonnegative(),
        }),
        graph: z.object({
          fileCount: z.number().int().nonnegative(),
          symbolCount: z.number().int().nonnegative(),
          edgeCount: z.number().int().nonnegative(),
        }),
        diagnostics: z.object({
          total: z.number().int().nonnegative(),
          byKind: z.record(z.string(), z.number().int().nonnegative()),
        }),
        truncated: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ mode }) => {
      const effectiveMode: RefreshMode = mode ?? "incremental";
      const result = await session.refresh(effectiveMode);
      const nodes = result.analysis.graph.getNodes();
      const diagnosticsByKind: Record<string, number> = {};
      for (const diagnostic of result.analysis.diagnostics) {
        diagnosticsByKind[diagnostic.kind] =
          (diagnosticsByKind[diagnostic.kind] ?? 0) + 1;
      }
      const added = result.files.added.slice(0, MAX_FILE_RESULTS);
      const changed = result.files.changed.slice(0, MAX_FILE_RESULTS);
      const deleted = result.files.deleted.slice(0, MAX_FILE_RESULTS);
      const affected = result.files.affected.slice(0, MAX_FILE_RESULTS);
      const structuredContent = {
        mode: effectiveMode,
        indexPath: path.relative(session.rootDirectory, session.indexPath),
        files: {
          added,
          changed,
          deleted,
          affected,
          reusedCount: result.files.reused.length,
        },
        graph: {
          fileCount: nodes.filter((node) => node.data.nodeType === "file").length,
          symbolCount: nodes.filter((node) => node.data.nodeType === "symbol").length,
          edgeCount: result.analysis.graph.edgeCount,
        },
        diagnostics: {
          total: result.analysis.diagnostics.length,
          byKind: diagnosticsByKind,
        },
        truncated:
          result.files.added.length > added.length ||
          result.files.changed.length > changed.length ||
          result.files.deleted.length > deleted.length ||
          result.files.affected.length > affected.length,
      };
      return toolResult(
        `Refreshed the index in ${effectiveMode} mode; ${result.files.affected.length} files were affected.`,
        structuredContent,
      );
    },
  );

  return server;
}

function registerRelationshipTool(
  server: McpServer,
  session: CodeGraphProjectSession,
  name: "get_dependencies" | "get_dependents",
  title: string,
  description: string,
  direction: "outgoing" | "incoming",
): void {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: {
        nodeId: z.string().min(1),
        relationships: relationshipTypesInput,
        limit: limitInput,
      },
      outputSchema: {
        subject: entitySummarySchema,
        relationships: z.array(relationshipResultSchema),
        totalRelationships: z.number().int().nonnegative(),
        truncated: z.boolean(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ nodeId, relationships, limit }) => {
      const analysis = await session.getAnalysis();
      const subject = requiredNode(analysis.graph, nodeId);
      const allowed = new Set<CodeGraphEdgeType>(
        relationships ?? ["CALLS", "IMPORTS"],
      );
      const edges = direction === "outgoing"
        ? analysis.graph.getOutgoingEdges(nodeId)
        : analysis.graph.getIncomingEdges(nodeId);
      const matching = edges
        .filter(
          (edge): edge is GraphEdge<"CALLS" | "IMPORTS", CodeGraphEdgeData> =>
            edge.type !== "DEFINES" && allowed.has(edge.type),
        )
        .map((edge) => {
          const relatedId = direction === "outgoing" ? edge.to : edge.from;
          return {
            entity: toEntitySummary(requiredNode(analysis.graph, relatedId)),
            relationship: toRelationshipSummary(edge),
          };
        })
        .sort((left, right) => entitySortKey(left.entity).localeCompare(
          entitySortKey(right.entity),
        ));
      const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
      const selected = matching.slice(0, effectiveLimit);
      const structuredContent = {
        subject: toEntitySummary(subject),
        relationships: selected,
        totalRelationships: matching.length,
        truncated: matching.length > selected.length,
      };
      return toolResult(
        `Found ${matching.length} ${direction === "outgoing" ? "dependencies" : "dependents"}; returned ${selected.length}.`,
        structuredContent,
      );
    },
  );
}

function findBoundedPath(
  graph: CodeGraph,
  fromNodeId: string,
  toNodeId: string,
  relationships: readonly ("CALLS" | "IMPORTS")[],
  maxDepth: number,
): readonly PathEntry[] | null {
  requiredNode(graph, fromNodeId);
  requiredNode(graph, toNodeId);
  if (fromNodeId === toNodeId) {
    return [{ entity: toEntitySummary(requiredNode(graph, fromNodeId)), via: null }];
  }

  const allowed = new Set<CodeGraphEdgeType>(relationships);
  const visited = new Set<string>([fromNodeId]);
  const parent = new Map<
    string,
    { readonly id: string; readonly relationship: RelationshipSummary }
  >();
  const queue: Array<{ readonly id: string; readonly depth: number }> = [
    { id: fromNodeId, depth: 0 },
  ];
  let nextIndex = 0;

  while (nextIndex < queue.length) {
    const current = queue[nextIndex];
    nextIndex += 1;
    if (current === undefined || current.depth >= maxDepth) {
      continue;
    }
    for (const edge of graph.getOutgoingEdges(current.id)) {
      if (
        edge.type === "DEFINES" ||
        !allowed.has(edge.type) ||
        visited.has(edge.to)
      ) {
        continue;
      }
      visited.add(edge.to);
      parent.set(edge.to, {
        id: current.id,
        relationship: toRelationshipSummary(edge),
      });
      if (edge.to === toNodeId) {
        return reconstructPath(graph, parent, fromNodeId, toNodeId);
      }
      queue.push({ id: edge.to, depth: current.depth + 1 });
    }
  }
  return null;
}

function reconstructPath(
  graph: CodeGraph,
  parent: ReadonlyMap<
    string,
    { readonly id: string; readonly relationship: RelationshipSummary }
  >,
  fromNodeId: string,
  toNodeId: string,
): readonly PathEntry[] {
  const reversedIds = [toNodeId];
  let currentId = toNodeId;
  while (currentId !== fromNodeId) {
    const entry = parent.get(currentId);
    if (entry === undefined) {
      throw new Error("Internal path reconstruction invariant failed");
    }
    currentId = entry.id;
    reversedIds.push(currentId);
  }
  const ids = reversedIds.reverse();
  return ids.map((id, index) => ({
    entity: toEntitySummary(requiredNode(graph, id)),
    via: index === 0 ? null : parent.get(id)?.relationship ?? null,
  }));
}

function summarizeImpact(
  impact: ImpactResult,
  maxResults: number,
): {
  readonly changed: EntitySummary;
  readonly directDependents: readonly EntitySummary[];
  readonly indirectDependents: readonly EntitySummary[];
  readonly affectedFiles: readonly string[];
  readonly counts: {
    readonly direct: number;
    readonly indirect: number;
    readonly affectedFiles: number;
  };
  readonly truncated: boolean;
} {
  const directDependents = impact.directDependents
    .slice(0, maxResults)
    .map(toEntitySummary);
  const remaining = Math.max(0, maxResults - directDependents.length);
  const indirectDependents = impact.indirectDependents
    .slice(0, remaining)
    .map(toEntitySummary);
  const affectedFiles = impact.affectedFiles.slice(0, maxResults);
  return {
    changed: toEntitySummary(impact.changed),
    directDependents,
    indirectDependents,
    affectedFiles,
    counts: {
      direct: impact.directDependents.length,
      indirect: impact.indirectDependents.length,
      affectedFiles: impact.affectedFiles.length,
    },
    truncated:
      directDependents.length + indirectDependents.length <
        impact.directDependents.length + impact.indirectDependents.length ||
      affectedFiles.length < impact.affectedFiles.length,
  };
}

function requiredNode(
  graph: CodeGraph,
  nodeId: string,
): GraphNode<CodeGraphNodeData> {
  const node = graph.getNode(nodeId);
  if (node === undefined) {
    throw new Error(`Node does not exist: ${nodeId}`);
  }
  return node;
}

function toEntitySummary(
  node: GraphNode<CodeGraphNodeData>,
): EntitySummary {
  if (node.data.nodeType === "file") {
    return {
      id: node.id,
      type: "file",
      name: null,
      qualifiedName: null,
      declarationKind: null,
      source: {
        path: node.data.filePath,
        startLine: null,
        startColumn: null,
        endLine: null,
        endColumn: null,
      },
    };
  }
  return {
    id: node.id,
    type: "symbol",
    name: node.data.name,
    qualifiedName: node.data.qualifiedName,
    declarationKind: node.data.declarationKind,
    source: {
      path: node.data.range.file,
      startLine: node.data.range.startLine,
      startColumn: node.data.range.startColumn,
      endLine: node.data.range.endLine,
      endColumn: node.data.range.endColumn,
    },
  };
}

function toRelationshipSummary(
  edge: GraphEdge<CodeGraphEdgeType, CodeGraphEdgeData>,
): RelationshipSummary {
  const data = edge.data;
  if (edge.type === "CALLS" && data?.relationship === "CALLS") {
    return {
      type: "CALLS",
      confidence: data.confidence,
      provenance: data.provenance,
      moduleSpecifier: null,
      source: {
        path: data.location.file,
        line: data.location.line,
        column: data.location.column,
      },
    };
  }
  if (edge.type === "IMPORTS" && data?.relationship === "IMPORTS") {
    return {
      type: "IMPORTS",
      confidence: data.confidence,
      provenance: data.provenance,
      moduleSpecifier: data.moduleSpecifier,
      source: null,
    };
  }
  throw new Error(`Missing ${edge.type} relationship metadata`);
}

function entitySortKey(entity: EntitySummary): string {
  return entity.qualifiedName ?? entity.source.path;
}

function toolResult<T extends Record<string, unknown>>(
  text: string,
  structuredContent: T,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
} {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}
