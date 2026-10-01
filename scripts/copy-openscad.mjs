// Copies the OpenSCAD WASM bundle into /public so the Web Worker can load it
// directly, without going through the Next.js bundler (it's ~11 MB).
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/openscad-wasm-prebuilt/dist/openscad.js");
const destDir = join(root, "public/vendor");
if (!existsSync(src)) {
  console.warn("[copy-openscad] openscad-wasm-prebuilt not installed yet; skipping");
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, join(destDir, "openscad.js"));
console.log("[copy-openscad] copied openscad.js -> public/vendor/");
