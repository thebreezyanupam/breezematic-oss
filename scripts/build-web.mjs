import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the public website into web/ from src/web/.
 *
 * The site is static and has no accounts: it describes the open-source project
 * and points at the repository. It is its own page, not the app's landing page
 * patched -- the app's local page signs people in, and this one never does.
 *
 *   src/web/index.html   the page
 *   src/web/frame.jpg    a frame from a BreezeMatic video, shown in the editor
 *   font.woff2           Inter, the one typeface
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'web');
const FONT = path.join(ROOT, 'src', 'remotion', 'fonts', 'inter-latin-wght-normal.woff2');
const OUT = path.join(ROOT, 'web');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(SRC, 'index.html'), path.join(OUT, 'index.html'));
fs.copyFileSync(path.join(SRC, 'frame.jpg'), path.join(OUT, 'frame.jpg'));
fs.copyFileSync(FONT, path.join(OUT, 'font.woff2'));

for (const name of fs.readdirSync(OUT)) {
  console.log(`${name.padEnd(16)} ${Math.round(fs.statSync(path.join(OUT, name)).size / 1024)} KB`);
}
