"use client";

import type { PhysicsReport, PhysicsSpec } from "@/lib/client";

let worker: Worker | null = null;
let runs = 0;
let nextId = 1;
const pending = new Map<number, { resolve: (r: PhysicsReport) => void; reject: (e: Error) => void }>();

function getWorker() {
  // Recycle the worker now and then so WASM memory from earlier checks is released.
  if (worker && runs >= 5) {
    worker.terminate();
    worker = null;
  }
  if (worker) return worker;
  runs = 0;
  worker = new Worker("/physics-worker.js", { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const { id, ok, report, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(report);
    else p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    for (const [id, p] of pending) {
      p.reject(new Error(`Physics engine failed to load: ${e.message || "unknown error"}`));
      pending.delete(id);
    }
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Run the two-body fit check (manifold-3d geometry + MuJoCo simulation) in a Web Worker.
 * The STL buffers are copied, so the caller's buffers stay usable.
 */
export function runPhysicsCheck(part1Stl: ArrayBuffer, spec: PhysicsSpec, part2Stl?: ArrayBuffer): Promise<PhysicsReport> {
  const id = nextId++;
  const w = getWorker();
  runs++;
  const a = part1Stl.slice(0);
  const b = part2Stl?.slice(0);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, part1Stl: a, part2Stl: b, spec }, b ? [a, b] : [a]);
  });
}
