#!/usr/bin/env node
// Convert a saved Observable notebook page to the new .html notebook format.
// Usage: node tools/obs-export.mjs saved-page.html [-o file-or-dir]
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { exportFromPageHtml } from "../nbks/obs-export.mjs";

const args = process.argv.slice(2);
const oi = args.findIndex((a) => a === "-o" || a === "--out");
const out = oi >= 0 ? args.splice(oi, 2)[1] : ".";
const [input] = args;
if (!input) {
  console.error("Usage: node tools/obs-export.mjs saved-page.html [-o file-or-dir]");
  process.exit(1);
}

try {
  const { html, filename, cellCount } = exportFromPageHtml(await readFile(input, "utf8"));
  const isDir = await stat(out).then((s) => s.isDirectory(), () => false);
  const target = isDir || out.endsWith("/") || !path.extname(out) ? path.join(out, filename) : out;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html);
  console.error(`Wrote ${target} (${cellCount} cells)`);
} catch (err) {
  console.error("obs-export failed: " + err.message);
  process.exit(1);
}
