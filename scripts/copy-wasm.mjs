// Copies the WebAssembly engines into /public/vendor so the Web Workers can load them directly,
// without going through the Next.js bundler:
//   OpenSCAD (~11 MB)  -> compiles .scad to STL
//   MuJoCo   (~10 MB)  -> physics simulation
//   Manifold (~0.5 MB) -> mesh booleans / clearance measurement
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ["openscad-wasm-prebuilt/dist/openscad.js", "openscad.js"],
  ["@mujoco/mujoco/mujoco.js", "mujoco/mujoco.js"],
  ["@mujoco/mujoco/mujoco.wasm", "mujoco/mujoco.wasm"],
  ["manifold-3d/manifold.js", "manifold/manifold.js"],
  ["manifold-3d/manifold.wasm", "manifold/manifold.wasm"],
];

for (const [from, to] of files) {
  const src = join(root, "node_modules", from);
  const dest = join(root, "public/vendor", to);
  if (!existsSync(src)) {
    console.warn(`[copy-wasm] ${from} not installed yet; skipping`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
console.log("[copy-wasm] copied WASM engines -> public/vendor/");
