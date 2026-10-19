import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { parseFrontmatterSafe } from "@2nd-brain/okf";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import { walkMarkdownFiles } from "../vaults/walk.js";

export const search = new Hono();

export interface SearchHit {
  file: string;
  line: number;
  snippet: string;
}

export interface SearchResult {
  groups: Record<string, SearchHit[]>;
}

search.get("/:id/search", async (c) => {
  const id = c.req.param("id");
  const reg = await readRegistry();
  const record = reg.vaults.find((v) => v.id === id);
  if (!record) {
    return c.json({ error: "not_found", message: "Unknown vault." }, 404);
  }

  const query = c.req.query("q")?.trim();
  if (!query) {
    return c.json<SearchResult>({ groups: {} }, 200);
  }

  const vaultDir = vaultDirPath(record.id);
  const files = await walkMarkdownFiles(vaultDir);
  const groups: Record<string, SearchHit[]> = {};
  const queryLower = query.toLowerCase();

  for (const { relPath, absPath } of files) {
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatterSafe(content);
    const frontmatter = parsed ? parsed.data : null;
    const type =
      typeof frontmatter?.type === "string" && String(frontmatter.type).trim() !== ""
        ? String(frontmatter.type).trim()
        : "other";

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.toLowerCase().includes(queryLower)) {
        if (!groups[type]) groups[type] = [];
        groups[type].push({
          file: relPath,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    }
  }

  return c.json<SearchResult>({ groups }, 200);
});
