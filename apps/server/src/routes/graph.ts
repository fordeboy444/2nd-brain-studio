import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { linkTarget, parseFrontmatterSafe, resolveBundlePath } from "@2nd-brain/okf";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import { walkMarkdownFiles } from "../vaults/walk.js";

export const graph = new Hono();

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  path: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function deriveEdgeKind(heading?: string): string {
  if (!heading) return "link";
  const h = heading.toLowerCase();
  if (h.includes("concept")) return "concept";
  if (h.includes("source") || h.includes("video") || h.includes("page")) return "source";
  if (h.includes("tool")) return "tool";
  if (h.includes("related") || h.includes("see also")) return "related";
  return "link";
}

graph.get("/:id/graph", async (c) => {
  const id = c.req.param("id");
  const reg = await readRegistry();
  const record = reg.vaults.find((v) => v.id === id);
  if (!record) {
    return c.json({ error: "not_found", message: "Unknown vault." }, 404);
  }

  const vaultDir = vaultDirPath(record.id);
  const mdFiles = await walkMarkdownFiles(vaultDir);

  const nodes: GraphNode[] = [];
  const fileContents = new Map<string, string>();
  const knownIds = new Set<string>();

  for (const { relPath, absPath } of mdFiles) {
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    fileContents.set(relPath, content);
    knownIds.add(relPath);

    const parsed = parseFrontmatterSafe(content);
    const frontmatter = parsed ? parsed.data : null;
    const basename = relPath.split("/").pop()?.replace(/\.md$/, "") ?? relPath;
    const label =
      typeof frontmatter?.title === "string" && String(frontmatter.title).trim() !== ""
        ? String(frontmatter.title).trim()
        : basename;
    const type =
      typeof frontmatter?.type === "string" && String(frontmatter.type).trim() !== ""
        ? String(frontmatter.type).trim()
        : "note";

    nodes.push({
      id: relPath,
      label,
      type,
      path: relPath,
    });
  }

  const edges: GraphEdge[] = [];
  const edgeSet = new Set<string>();

  for (const [sourcePath, content] of fileContents.entries()) {
    const lines = content.split("\n");
    let currentHeading: string | undefined = undefined;
    let inFence = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        currentHeading = headingMatch[1]!.trim();
      }

      const linkMatches = line.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g);
      for (const match of linkMatches) {
        const rawTarget = match[2]!;
        const clean = linkTarget(rawTarget);
        if (!clean) continue;

        const resolved = resolveBundlePath(sourcePath, clean);
        if (!resolved || !knownIds.has(resolved) || resolved === sourcePath) {
          continue; // skip dangling refs and self-loops
        }

        const kind = deriveEdgeKind(currentHeading);
        const edgeKey = `${sourcePath}->${resolved}:${kind}`;
        if (edgeSet.has(edgeKey)) continue;
        edgeSet.add(edgeKey);

        edges.push({
          source: sourcePath,
          target: resolved,
          kind,
        });
      }
    }
  }

  return c.json<GraphResult>({ nodes, edges }, 200);
});
