// Fit & physics check worker. Runs MuJoCo (WASM) and manifold-3d (WASM) in the browser.
// Message in:  { id, part1Stl: ArrayBuffer, part2Stl?: ArrayBuffer, spec }
// Message out: { id, ok: true, report } | { id, ok: false, error }
import loadMujoco from "/vendor/mujoco/mujoco.js";
import loadManifold from "/vendor/manifold/manifold.js";
import { runFitCheck } from "/physics/fit-check.js";

let engines = null;
function getEngines() {
  engines ??= Promise.all([
    loadMujoco(),
    loadManifold().then((mf) => {
      mf.setup();
      return mf;
    }),
  ]);
  return engines;
}

self.onmessage = async (e) => {
  const { id, part1Stl, part2Stl, spec } = e.data;
  try {
    const [mj, mf] = await getEngines();
    const report = runFitCheck({ mj, mf, part1Stl, part2Stl, spec });
    self.postMessage({ id, ok: true, report });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
