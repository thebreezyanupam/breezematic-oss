import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Builds the public website into web/ from src/web/.
 *
 * The site is static and has no accounts: it describes the open-source project
 * and points at the repository. It is its own page, not the app's landing page
 * patched -- the app's local page signs people in, and this one never does.
 *
 *   src/web/index.html   the page
 *   src/web/hero.jpg     the painted hero (made with the painted look's engine)
 *   web/showreel.mp4     a short re-encoded small, from SHOWREEL=<file> or the
 *                        newest MP4 in out/; SHOWREEL=keep keeps the one in web/
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'web');
const FONT = path.join(ROOT, 'src', 'remotion', 'fonts', 'inter-latin-wght-normal.woff2');
const OUT = path.join(ROOT, 'web');
const FFMPEG = process.env['FFMPEG_BIN'] ?? 'ffmpeg';

function pickShowreel() {
  const wanted = process.env['SHOWREEL'];
  if (wanted === 'keep') return null;
  if (wanted !== undefined && wanted !== '') return path.resolve(ROOT, wanted);
  const dir = path.join(ROOT, 'out');
  if (!fs.existsSync(dir)) return null;
  const newest = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.mp4'))
    .map((name) => ({ file: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  return newest?.file ?? null;
}

const reel = pickShowreel();
const reelOut = path.join(OUT, 'showreel.mp4');
const posterOut = path.join(OUT, 'showreel.jpg');
// web/ is committed, so the reel in it may be the only copy: keep it when there is nothing new.
const kept = reel === null && fs.existsSync(reelOut) ? fs.readFileSync(reelOut) : null;
const keptPoster = reel === null && fs.existsSync(posterOut) ? fs.readFileSync(posterOut) : null;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(SRC, 'index.html'), path.join(OUT, 'index.html'));
fs.copyFileSync(path.join(SRC, 'hero.jpg'), path.join(OUT, 'hero.jpg'));
fs.copyFileSync(FONT, path.join(OUT, 'font.woff2'));

if (reel !== null) {
  // A web asset, not a master: half size, no sound, the first twenty seconds.
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', reel, '-an', '-vf', 'scale=540:-2',
    '-c:v', 'libx264', '-crf', '30', '-preset', 'slow', '-movflags', '+faststart', '-t', '20', reelOut], { stdio: 'inherit' });
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2.5', '-i', reel, '-frames:v', '1',
    '-vf', 'scale=540:-2', '-q:v', '4', posterOut], { stdio: 'inherit' });
  console.log(`showreel  ${path.basename(reel)} -> web/showreel.mp4`);
} else if (kept !== null) {
  fs.writeFileSync(reelOut, kept);
  if (keptPoster !== null) fs.writeFileSync(posterOut, keptPoster);
  console.log('showreel  kept the committed one');
}

for (const name of fs.readdirSync(OUT)) {
  console.log(`${name.padEnd(16)} ${Math.round(fs.statSync(path.join(OUT, name)).size / 1024)} KB`);
}
