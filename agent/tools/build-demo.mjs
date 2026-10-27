// Bundles public/index.html + the recorded frames into one self-contained demo page.
import fs from "node:fs";
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const frames = fs.readFileSync(new URL("../public/demo-frames.js", import.meta.url), "utf8");
// artifact pages get their own document skeleton, so drop ours
const out = html
  .replace(/<!doctype html>\s*<html[^>]*>\s*<head>\s*/i, "")
  .replace(/<meta charset="utf-8">\s*<meta name="viewport"[^>]*>\s*/i, "")
  .replace("<title>KAVACH desk</title>", "<title>KAVACH Agent Desk</title>")
  .replace(/<\/head>\s*<body>/i, "")
  .replace(/<\/body>\s*<\/html>\s*$/i, "")
  .replace("<script>\nconst $ =", `<script>${frames}</script>\n<script>\nconst $ =`);
fs.mkdirSync(new URL("../../demo/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../../demo/kavach-demo.html", import.meta.url), out);
console.log("demo/kavach-demo.html", out.length, "bytes");
