// Collects the static app into www/, which is what Capacitor packages into
// the native builds. Keeping the source at the repo root means GitHub Pages
// serves it directly with no build step; this only exists for the app wrapper.
import { mkdirSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FILES = ["index.html", "app.js", "config.js", "manifest.webmanifest", "sw.js"];
const DIRS = ["icons"];

rmSync("www", { recursive: true, force: true });
mkdirSync("www", { recursive: true });

for (const f of FILES) copyFileSync(f, join("www", f));
for (const d of DIRS) {
  mkdirSync(join("www", d), { recursive: true });
  for (const f of readdirSync(d)) {
    if (statSync(join(d, f)).isFile()) copyFileSync(join(d, f), join("www", d, f));
  }
}
console.log(`www/ built — ${FILES.length} files + ${DIRS.join(", ")}`);
