import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { linkTarget, resolveBundlePath } from "@2nd-brain/okf";
import { PathJailError, decodePathParam, resolveInVault } from "../paths/jail.js";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import { walkMarkdownFiles } from "../vaults/walk.js";

export const backlinks = new Hono();

export interface BacklinkEntry {
  source: string;
  heading?: string;
  text: string;
}

export interface BacklinksResult {
  target: string;
  backlinks: BacklinkEntry[];
}

backlinks.get("/:id/backlinks", async (c) => {
  const id = c.req.param("id");
  const reg = await readRegistry();
  const record = reg.vaults.find((v) => v.id === id);
  if (!record) {
    return c.json({ error: "not_found", message: "Unknown vault." }, 404);
  }

  const rawFile = c.req.query("file")?.trim();
  if (!rawFile) {
    return c.json({ error: "invalid_path", message: "Missing file parameter." }, 400);
  }

  const vaultDir = vaultDirPath(record.id);
  let targetRelPath: string;
  try {
    const decoded = decodePathParam(rawFile);
    const resolved = await resolveInVault(vaultDir, decoded);
    targetRelPath = resolved.relPath;
  } catch (err) {
    if (err instanceof PathJailError) {
      return c.json({ error: "invalid_path", message: "Invalid path." }, 400);
    }
    throw err;
  }

  const files = await walkMarkdownFiles(vaultDir);
  const backlinkList: BacklinkEntry[] = [];

  for (const { relPath, absPath } of files) {
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      continue;
    }

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

      // Markdown links: [text](target)
      const linkMatches = line.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g);
      for (const match of linkMatches) {
        const text = match[1]!;
        const rawTarget = match[2]!;
        const clean = linkTarget(rawTarget);
        if (!clean) continue;

        const resolved = resolveBundlePath(relPath, clean);
        if (resolved === targetRelPath) {
          backlinkList.push({
            source: relPath,
            ...(currentHeading ? { heading: currentHeading } : {}),
            text,
          });
        }
      }
    }
  }

  return c.json<BacklinksResult>({ target: targetRelPath, backlinks: backlinkList }, 200);
});
