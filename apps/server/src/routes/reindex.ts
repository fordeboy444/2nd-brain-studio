import { Hono } from "hono";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildIndexes, buildRootIndex } from "@2nd-brain/okf";
import { resolveInVault } from "../paths/jail.js";
import { readRegistry, vaultDirPath } from "../vaults/registry.js";
import { collectAllVaultPages } from "./lint.js";

export const reindex = new Hono();

reindex.post("/:id/reindex", async (c) => {
  const id = c.req.param("id");
  const reg = await readRegistry();
  const record = reg.vaults.find((v) => v.id === id);
  if (!record) {
    return c.json({ error: "not_found", message: "Unknown vault." }, 404);
  }

  const vaultDir = vaultDirPath(record.id);
  const pages = await collectAllVaultPages(vaultDir);
  const result = buildIndexes(pages, {});

  const updatedPaths: string[] = [];
  for (const file of result.files) {
    const { absPath } = await resolveInVault(vaultDir, file.path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, file.text, "utf-8");
    updatedPaths.push(file.path);
  }

  const rootIndexPage = pages.find((p) => p.path === "index.md");
  if (rootIndexPage) {
    const newRoot = buildRootIndex(rootIndexPage.text, pages);
    const { absPath } = await resolveInVault(vaultDir, "index.md");
    await writeFile(absPath, newRoot, "utf-8");
    updatedPaths.push("index.md");
  }

  if (result.log.length > 0) {
    const { absPath } = await resolveInVault(vaultDir, "log.md");
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, `${result.log.join("\n")}\n`, "utf-8");
    updatedPaths.push("log.md");
  }

  return c.json({ ok: true, updated: updatedPaths }, 200);
});
