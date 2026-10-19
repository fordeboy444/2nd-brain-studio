import { Hono, type Context } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { lintBundle, type BundlePage, type LintResult } from "@2nd-brain/okf";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import { walkMarkdownFiles } from "../vaults/walk.js";

export const lint = new Hono();

export async function collectAllVaultPages(vaultDir: string): Promise<BundlePage[]> {
  const mdFiles = await walkMarkdownFiles(vaultDir);
  const pages: BundlePage[] = [];
  for (const { relPath, absPath } of mdFiles) {
    try {
      const text = await readFile(absPath, "utf-8");
      pages.push({ path: relPath, text });
    } catch {
      continue;
    }
  }
  return pages;
}

export async function collectVaultDirectories(vaultDir: string): Promise<string[]> {
  const collected: string[] = [];
  async function walk(currentRel: string): Promise<void> {
    const currentAbs = currentRel === "" ? vaultDir : join(vaultDir, currentRel);
    let dirents;
    try {
      dirents = await readdir(currentAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (!entry.isDirectory()) continue;
      const childRel = currentRel === "" ? entry.name : `${currentRel}/${entry.name}`;
      collected.push(childRel);
      await walk(childRel);
    }
  }
  await walk("");
  return collected.sort();
}

async function handleLint(c: Context): Promise<Response> {
  const id = c.req.param("id");
  const reg = await readRegistry();
  const record = reg.vaults.find((v) => v.id === id);
  if (!record) {
    return c.json({ error: "not_found", message: "Unknown vault." }, 404);
  }

  const vaultDir = vaultDirPath(record.id);
  const pages = await collectAllVaultPages(vaultDir);
  const dirs = await collectVaultDirectories(vaultDir);
  const result: LintResult = lintBundle(pages, record.name || record.id, { paths: dirs });

  return c.json(
    {
      ok: result.errors.length === 0,
      errors: result.errors,
      warnings: result.warnings,
      scanned: result.scanned,
    },
    200,
  );
}

lint.get("/:id/lint", handleLint);
lint.post("/:id/lint", handleLint);
