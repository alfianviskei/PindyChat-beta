#!/usr/bin/env node
/**
 * Regenerates the PNG icons in `client/public/assets` from `logo.svg`.
 *
 * The manifest and the document head reference five raster sizes that cannot be
 * derived at runtime, so they are committed. This script is how they stay in
 * step with the mark: replace `logo.svg`, run this, commit the PNGs. Nothing
 * else in the build reads it.
 *
 * Requires `rsvg-convert` on PATH (Alpine: `apk add rsvg-convert`):
 *
 *   docker run --rm -v "$PWD:/app" -w /app/client node:22-alpine \
 *     sh -c 'apk add --no-cache rsvg-convert >/dev/null && node scripts/generate-icons.mjs'
 *
 * Each icon is the artwork centred on a transparent square canvas. Padding is
 * per target: the small favicons get none, because a detailed mark at 16px needs
 * every pixel, while `maskable-icon.png` gets enough to keep the artwork inside
 * the centre 80% safe zone a launcher is allowed to crop to.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets');
const sourcePath = path.join(assetsDir, 'logo.svg');

const TARGETS = [
  { file: 'favicon-16x16.png', size: 16, padding: 0 },
  { file: 'favicon-32x32.png', size: 32, padding: 0 },
  { file: 'apple-touch-icon-180x180.png', size: 180, padding: 0.04 },
  { file: 'icon-192x192.png', size: 192, padding: 0.04 },
  { file: 'maskable-icon.png', size: 512, padding: 0.2 },
];

const source = fs.readFileSync(sourcePath, 'utf8');

/**
 * Splits the artwork into its root tag and body. The generated mark carries its
 * intrinsic size as `width`/`height` with no `viewBox`, so the body is replayed
 * inside a `<g>` transform rather than relying on a coordinate system of its own.
 */
const rootMatch = source.match(/<svg\b([^>]*)>/);
if (rootMatch == null) {
  throw new Error(`${sourcePath} has no <svg> root element`);
}
const attrs = rootMatch[1];
const body = source.slice(rootMatch.index + rootMatch[0].length, source.lastIndexOf('</svg>'));

const readDimension = (name) => {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([\\d.]+)"`));
  return match == null ? undefined : Number.parseFloat(match[1]);
};
const viewBox = attrs.match(/\bviewBox\s*=\s*"([\d.\s-]+)"/);
const [artWidth, artHeight] = viewBox
  ? viewBox[1].trim().split(/[\s,]+/).slice(2).map(Number.parseFloat)
  : [readDimension('width'), readDimension('height')];

if (!(artWidth > 0) || !(artHeight > 0)) {
  throw new Error(`${sourcePath} declares no usable width/height or viewBox`);
}

for (const { file, size, padding } of TARGETS) {
  const scale = (size * (1 - 2 * padding)) / Math.max(artWidth, artHeight);
  const drawnWidth = artWidth * scale;
  const drawnHeight = artHeight * scale;
  const offsetX = (size - drawnWidth) / 2;
  const offsetY = (size - drawnHeight) / 2;

  const canvas = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<g transform="translate(${offsetX} ${offsetY}) scale(${scale})">`,
    body,
    '</g>',
    '</svg>',
  ].join('');

  const outPath = path.join(assetsDir, file);
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outPath], {
    input: canvas,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log(`wrote ${path.relative(process.cwd(), outPath)} (${size}x${size})`);
}
