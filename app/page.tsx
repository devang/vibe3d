"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compileScad } from "@/lib/scad/compile";
import { applyParams, parseParams, type ScadParam } from "@/lib/scad/params";
import { resizeImage, downloadBlob } from "@/lib/image";
import { EXAMPLE_KNOB } from "@/lib/examples";
import type { ModelInfo, ViewerHandle } from "@/components/Viewer";

const Viewer = dynamic(() => import("@/components/Viewer"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-slate-500">Loading viewer…</div>,
});

type Part = {
  title: string;
  summary: string;
  measurements: { name: string; value_mm: number; confidence: string; note?: string }[];
  assumptions: string[];
  warnings?: string[];
  scad_code: string;
};

type LogEntry = { kind: "info" | "error" | "ai"; text: string };

const REFERENCES = [
  { key: "us_quarter", label: "US quarter (24.26 mm)" },
  { key: "us_penny", label: "US penny (19.05 mm)" },
  { key: "us_dollar", label: "US dollar bill (156 × 66 mm)" },
  { key: "credit_card", label: "Credit / ID card (85.6 × 54 mm)" },
  { key: "ruler", label: "Ruler" },
  { key: "none", label: "No reference" },
];

const MAX_FIX_ATTEMPTS = 3;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export default function Home() {
  // Inputs
  const [photos, setPhotos] = useState<string[]>([]);
  const [reference, setReference] = useState("us_quarter");
  const [prompt, setPrompt] = useState("");
  const [known, setKnown] = useState("");
  const [refineText, setRefineText] = useState("");

  // Design state
  const [part, setPart] = useState<Omit<Part, "scad_code"> | null>(null);
  const [code, setCode] = useState(EXAMPLE_KNOB);
  const [values, setValues] = useState<Record<string, number | boolean>>({});
  const [stl, setStl] = useState<ArrayBuffer | null>(null);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const viewerRef = useRef<ViewerHandle | null>(null);
  // Only change state if there are overrides, so we don't trigger a redundant re-compile.
  const resetValues = useCallback(() => setValues((v) => (Object.keys(v).length ? {} : v)), []);
  const params = useMemo(() => parseParams(code), [code]);
  const addLog = useCallback((kind: LogEntry["kind"], text: string) => setLog((l) => [...l.slice(-30), { kind, text }]), []);

  // ---- Compile -------------------------------------------------------------
  const compile = useCallback(
    async (src: string, defines: Record<string, number | boolean> = {}) => {
      const r = await compileScad(src, defines);
      if (r.ok) {
        setStl(r.stl);
        setCompileError(null);
        addLog("info", `Compiled in ${r.ms} ms`);
      } else {
        setCompileError(r.error);
      }
      return r;
    },
    [addLog],
  );

  /** Compile; if it fails, ask Gemini to fix the code (up to N times). */
  const compileWithAutoFix = useCallback(
    async (src: string) => {
      let current = src;
      for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        setBusy(attempt === 0 ? "Compiling…" : `Fixing compile error (attempt ${attempt})…`);
        const r = await compile(current);
        if (r.ok) return current;
        if (attempt === MAX_FIX_ATTEMPTS) break;
        addLog("error", r.error.split("\n").find((l) => /ERROR/.test(l)) ?? "Compile failed");
        try {
          const fixed = await postJson<Part>("/api/refine", { code: current, compileError: r.error });
          current = fixed.scad_code;
          setCode(current);
          resetValues();
        } catch (e) {
          addLog("error", (e as Error).message);
          break;
        }
      }
      return current;
    },
    [compile, addLog, resetValues],
  );

  // First load: compile the example so the viewer isn't empty.
  useEffect(() => {
    let cancelled = false;
    compileScad(EXAMPLE_KNOB).then((r) => {
      if (!cancelled && r.ok) setStl(r.stl);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-compile (debounced) when sliders change. No AI call needed.
  const firstValues = useRef(true);
  useEffect(() => {
    if (firstValues.current) {
      firstValues.current = false;
      return;
    }
    const t = setTimeout(() => compile(code, values), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const bakedCode = () => applyParams(code, values);

  // ---- Actions -------------------------------------------------------------
  async function onPhotos(files: FileList | null) {
    if (!files) return;
    const list = Array.from(files).slice(0, 4 - photos.length);
    const resized = await Promise.all(list.map((f) => resizeImage(f)));
    setPhotos((p) => [...p, ...resized].slice(0, 4));
  }

  async function generate() {
    setBusy("Asking Gemini to design the part…");
    addLog("ai", "Generating from " + (photos.length ? `${photos.length} photo(s) + prompt` : "prompt"));
    try {
      const r = await postJson<Part>("/api/generate", { prompt, images: photos, reference, knownMeasurements: known });
      const { scad_code, ...meta } = r;
      setPart(meta);
      setCode(scad_code);
      resetValues();
      await compileWithAutoFix(scad_code);
    } catch (e) {
      addLog("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function refine() {
    if (!refineText.trim()) return;
    setBusy("Applying your change…");
    addLog("ai", `Refine: ${refineText}`);
    try {
      const r = await postJson<Part>("/api/refine", { code: bakedCode(), instruction: refineText });
      const { scad_code, ...meta } = r;
      setPart((p) => ({ ...meta, title: meta.title || p?.title || "" }));
      setCode(scad_code);
      resetValues();
      setRefineText("");
      await compileWithAutoFix(scad_code);
    } catch (e) {
      addLog("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    if (!viewerRef.current || !stl) return;
    setBusy("Rendering views and checking with Gemini…");
    try {
      const renders = await viewerRef.current.capture();
      const src = bakedCode();
      const r = await postJson<{ matches: boolean; issues: string[]; scad_code: string }>("/api/verify", {
        code: src,
        prompt,
        photos,
        renders,
      });
      if (r.matches) {
        addLog("ai", "Verified: the model matches the request." + (r.issues.length ? " Notes: " + r.issues.join("; ") : ""));
      } else {
        addLog("ai", "Found issues: " + r.issues.join("; "));
        if (r.scad_code?.trim()) {
          setCode(r.scad_code);
          resetValues();
          await compileWithAutoFix(r.scad_code);
          addLog("ai", "Applied the suggested fix. Run Verify again to double-check.");
        }
      }
    } catch (e) {
      addLog("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function compileFromEditor() {
    setBusy("Compiling…");
    resetValues();
    await compile(code);
    setBusy(null);
  }

  const fileBase = (part?.title || "part").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part";

  // ---- UI ------------------------------------------------------------------
  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">vibe3d</h1>
          <span className="text-xs text-slate-400">Photo of a broken part → printable replacement</span>
        </div>
        {busy && (
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            {busy}
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Sidebar */}
        <aside className="min-h-0 w-full flex-1 space-y-5 overflow-y-auto border-slate-800 p-5 lg:w-[420px] lg:flex-none lg:border-r">
          <Section title="1. Photos" hint="Up to 4. Put the reference object flat, next to the part, same distance from the camera.">
            <div className="grid grid-cols-4 gap-2">
              {photos.map((p, i) => (
                <div key={i} className="group relative aspect-square overflow-hidden rounded-md border border-slate-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                  <button
                    onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}
                    className="absolute right-1 top-1 rounded bg-black/70 px-1.5 text-xs opacity-0 group-hover:opacity-100"
                    aria-label="Remove photo"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {photos.length < 4 && (
                <label className="grid aspect-square cursor-pointer place-items-center rounded-md border border-dashed border-slate-600 text-2xl text-slate-500 hover:border-amber-400 hover:text-amber-300">
                  +
                  <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => onPhotos(e.target.files)} />
                </label>
              )}
            </div>
            <label className="mt-3 block text-xs text-slate-400">Size reference in photo</label>
            <select
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
            >
              {REFERENCES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Section>

          <Section title="2. Describe it">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="e.g. Replacement knob for my stove. The D-shaped shaft hole cracked."
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-600"
            />
            <input
              value={known}
              onChange={(e) => setKnown(e.target.value)}
              placeholder="Known measurements (optional): shaft 6 mm, flat 4.6 mm"
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-600"
            />
            <button
              onClick={generate}
              disabled={!!busy || (!prompt.trim() && !photos.length)}
              className="mt-3 w-full rounded-md bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
            >
              Generate part
            </button>
          </Section>

          {part && (
            <Section title={part.title || "Design"}>
              <p className="text-sm text-slate-300">{part.summary}</p>
              {!!part.warnings?.length && (
                <ul className="mt-2 space-y-1 rounded-md border border-red-900 bg-red-950/50 p-2 text-xs text-red-200">
                  {part.warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              )}
              {!!part.measurements?.length && (
                <table className="mt-3 w-full text-xs">
                  <tbody>
                    {part.measurements.map((m, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="py-1 pr-2 text-slate-300">{m.name}</td>
                        <td className="py-1 pr-2 text-right font-mono">{m.value_mm} mm</td>
                        <td className="py-1 text-right">
                          <span className={`rounded px-1.5 py-0.5 ${confColor(m.confidence)}`}>{m.confidence}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!!part.assumptions?.length && (
                <details className="mt-2 text-xs text-slate-400">
                  <summary className="cursor-pointer">Assumptions ({part.assumptions.length})</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {part.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </details>
              )}
            </Section>
          )}

          {params.length > 0 && (
            <Section title="3. Adjust dimensions" hint="Instant, no AI needed. Measure with calipers where you can.">
              <ParamPanel params={params} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} />
              {Object.keys(values).length > 0 && (
                <button onClick={() => setValues({})} className="mt-2 text-xs text-slate-400 underline">
                  Reset to generated values
                </button>
              )}
            </Section>
          )}

          <Section title="4. Ask for a change">
            <div className="flex gap-2">
              <input
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && refine()}
                placeholder="Add a flange 3 mm wide at the base"
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-600"
              />
              <button
                onClick={refine}
                disabled={!!busy || !refineText.trim()}
                className="rounded-md bg-slate-700 px-3 text-sm hover:bg-slate-600 disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </Section>

          <details className="rounded-md border border-slate-800">
            <summary className="cursor-pointer px-3 py-2 text-sm text-slate-300">OpenSCAD code</summary>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              rows={18}
              className="w-full border-t border-slate-800 bg-slate-900 p-3 font-mono text-xs leading-relaxed"
            />
            <div className="flex justify-end p-2">
              <button onClick={compileFromEditor} disabled={!!busy} className="rounded bg-slate-700 px-3 py-1 text-xs hover:bg-slate-600">
                Compile
              </button>
            </div>
          </details>

          {log.length > 0 && (
            <div className="space-y-1 font-mono text-[11px]">
              {log.slice(-8).map((l, i) => (
                <div key={i} className={l.kind === "error" ? "text-red-400" : l.kind === "ai" ? "text-sky-300" : "text-slate-500"}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* Viewer */}
        <main className="relative order-first h-[45vh] shrink-0 border-b border-slate-800 lg:order-none lg:h-auto lg:flex-1 lg:border-b-0">
          <Viewer stl={stl} handleRef={viewerRef} onInfo={setInfo} />

          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-2 p-3">
            {info ? (
              <div data-testid="dims" className="rounded-md bg-black/60 px-3 py-2 font-mono text-xs text-slate-200 backdrop-blur">
                {info.x.toFixed(1)} × {info.y.toFixed(1)} × {info.z.toFixed(1)} mm
                <span className="ml-2 text-slate-500">{info.triangles.toLocaleString()} tris · grid 10 mm</span>
              </div>
            ) : (
              <span />
            )}
            <div className="pointer-events-auto flex gap-2">
              <button
                onClick={verify}
                disabled={!!busy || !stl}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium hover:bg-sky-500 disabled:opacity-40"
                title="Render the model from 4 angles and ask Gemini whether it matches"
              >
                AI check
              </button>
              <button
                onClick={() => stl && downloadBlob(stl, `${fileBase}.stl`, "model/stl")}
                disabled={!stl}
                className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
              >
                Download STL
              </button>
              <button
                onClick={() => downloadBlob(bakedCode(), `${fileBase}.scad`, "text/plain")}
                className="rounded-md bg-slate-700 px-3 py-1.5 text-xs hover:bg-slate-600"
              >
                .scad
              </button>
            </div>
          </div>

          {compileError && (
            <pre className="absolute inset-x-3 bottom-3 max-h-40 overflow-auto rounded-md border border-red-900 bg-red-950/90 p-3 text-xs text-red-200">
              {compileError}
            </pre>
          )}
        </main>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
      {hint && <p className="mb-2 mt-0.5 text-xs text-slate-500">{hint}</p>}
      <div className={hint ? "" : "mt-2"}>{children}</div>
    </section>
  );
}

function ParamPanel({
  params,
  values,
  onChange,
}: {
  params: ScadParam[];
  values: Record<string, number | boolean>;
  onChange: (name: string, v: number | boolean) => void;
}) {
  return (
    <div className="space-y-3">
      {params.map((p, i) => {
        const v = values[p.name] ?? p.value;
        const header = p.group && p.group !== params[i - 1]?.group ? p.group : null;
        return (
          <div key={p.name}>
            {header && <div className="mb-1 mt-3 text-[11px] uppercase tracking-wider text-slate-500">{header}</div>}
            {p.type === "boolean" ? (
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={v as boolean} onChange={(e) => onChange(p.name, e.target.checked)} />
                {p.description || p.name}
              </label>
            ) : (
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300" title={p.name}>
                    {p.description || p.name}
                  </span>
                  <input
                    type="number"
                    value={v as number}
                    step={p.step}
                    onChange={(e) => e.target.value !== "" && onChange(p.name, Number(e.target.value))}
                    className="w-20 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right font-mono"
                  />
                </div>
                <input
                  type="range"
                  min={Math.min(p.min!, v as number)}
                  max={Math.max(p.max!, v as number)}
                  step={p.step}
                  value={v as number}
                  onChange={(e) => onChange(p.name, Number(e.target.value))}
                  className="w-full accent-amber-500"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function confColor(c: string) {
  if (c === "high") return "bg-emerald-900 text-emerald-200";
  if (c === "medium") return "bg-amber-900 text-amber-200";
  return "bg-red-900 text-red-200";
}
