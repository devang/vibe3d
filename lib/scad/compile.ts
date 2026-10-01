"use client";

export type CompileResult =
  | { ok: true; stl: ArrayBuffer; log: string; ms: number }
  | { ok: false; error: string; log: string; ms: number };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: CompileResult) => void; start: number }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/scad-worker.js", { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const { id, ...rest } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.resolve({ ...rest, ms: Math.round(performance.now() - p.start) } as CompileResult);
  };
  worker.onerror = (e) => {
    for (const [id, p] of pending) {
      p.resolve({ ok: false, error: `Worker error: ${e.message}`, log: "", ms: 0 });
      pending.delete(id);
    }
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Compile OpenSCAD source to a binary STL in a Web Worker. */
export function compileScad(code: string, defines: Record<string, number | boolean> = {}): Promise<CompileResult> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve, start: performance.now() });
    getWorker().postMessage({ id, code, defines });
  });
}
