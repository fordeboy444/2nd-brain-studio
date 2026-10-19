import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { parseFrontmatterSafe } from "@2nd-brain/okf";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import { walkMarkdownFiles } from "../vaults/walk.js";

export const frontmatter = new Hono();

export interface FrontmatterIndexResult {
  files: Record<string, Record<string, unknown>>;
}

frontmatter.get("/:id/frontmatter", async (c) => {
  const id = c.req.param("id");
  const reg = await readRegistry();
  const record = reg.vaults.find((v) => v.id === id);
  if (!record) {
    return c.json({ error: "not_found", message: "Unknown vault." }, 404);
  }

  const vaultDir = vaultDirPath(record.id);
  const mdFiles = await walkMarkdownFiles(vaultDir);
  const result: Record<string, Record<string, unknown>> = {};

  for (const { relPath, absPath } of mdFiles) {
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatterSafe(content);
    result[relPath] = parsed ? (parsed.data as Record<string, unknown>) : {};
  }

  return c.json<FrontmatterIndexResult>({ files: result }, 200);
});
