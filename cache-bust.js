#!/usr/bin/env node
/**
 * Rename the patched JS file to a new hash so the Vite PWA service worker
 * (which precaches assets with revision:null using cache-first strategy)
 * misses its cache and fetches the patched content from the network.
 *
 * Also updates all references in index.html, sw.js, and the precache manifest,
 * and bumps the registerSW revision so the service worker itself is re-installed.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dist = "/app/client/dist";
const assets = path.join(dist, "assets");

// 1. Find the main index JS file
const indexJs = fs
  .readdirSync(assets)
  .find((f) => /^index\.[a-zA-Z0-9_-]+\.js$/.test(f));
if (!indexJs) {
  console.error("index JS not found");
  process.exit(1);
}
console.log("Found:", indexJs);

// 2. Compute new hash from content
const content = fs.readFileSync(path.join(assets, indexJs));
const newHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
const newName = `index.${newHash}.js`;
console.log("New name:", newName);

// 3. Rename file (skip if already correct)
if (indexJs !== newName) {
  fs.renameSync(path.join(assets, indexJs), path.join(assets, newName));
  console.log("Renamed");
} else {
  console.log("Already has correct name");
}

// 4. Update index.html
const indexPath = path.join(dist, "index.html");
let indexHtml = fs.readFileSync(indexPath, "utf8");
indexHtml = indexHtml.split(indexJs).join(newName);
// Add no-cache meta tags right after <meta charset> if not already present
if (!indexHtml.includes("cache-control")) {
  indexHtml = indexHtml.replace(
    /<meta charset="UTF-8" \/>/,
    '<meta charset="UTF-8" />\n    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />\n    <meta http-equiv="Pragma" content="no-cache" />\n    <meta http-equiv="Expires" content="0" />'
  );
}
fs.writeFileSync(indexPath, indexHtml);
console.log("Updated index.html");

// 5. Update sw.js (precached URL + registerSW revision bump)
const swPath = path.join(dist, "sw.js");
let sw = fs.readFileSync(swPath, "utf8");
sw = sw.split(indexJs).join(newName);
// Bump the registerSW revision so the SW itself is re-installed
const newRev = crypto.createHash("md5").update(String(Date.now())).digest("hex").slice(0, 16);
sw = sw.replace(
  /(\{url:"registerSW\.js",revision:")[^"]*("})/,
  `$1${newRev}$2`
);
fs.writeFileSync(swPath, sw);
console.log("Updated sw.js");

// 6. Update any other JS files that reference the old name
for (const f of fs.readdirSync(assets)) {
  if (!f.endsWith(".js") || f === newName) continue;
  const fp = path.join(assets, f);
  const c = fs.readFileSync(fp, "utf8");
  if (c.includes(indexJs)) {
    fs.writeFileSync(fp, c.split(indexJs).join(newName), "utf8");
    console.log("Updated reference in:", f);
  }
}

console.log("Done.");
