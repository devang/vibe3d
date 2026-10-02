"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Composer from "@/components/Composer";
import ChatThread from "@/components/ChatThread";
import ParamPanel from "@/components/ParamPanel";
import { compileScad } from "@/lib/scad/compile";
import { applyParams, parseParams } from "@/lib/scad/params";
import { downloadBlob } from "@/lib/image";
import { EXAMPLE_KNOB } from "@/lib/examples";
import { postJson, type ChatMessage, type Part, type PartMeta } from "@/lib/client";
import type { ModelInfo, ViewerHandle } from "@/components/Viewer";

const Viewer = dynamic(() => import("@/components/Viewer"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-slate-500">Loading viewer…</div>,
});

const MAX_FIX_ATTEMPTS = 3;

const SUGGESTIONS = [
  "Replacement battery cover for a TV remote",
  "Stove knob with a 6 mm D-shaped shaft",
  "Shelf support pin, 5 mm peg",
  "Dishwasher rack wheel",
];

let msgId = 1;

export default function Home() {
  // Which screen: the chat-style start screen, or the 3D workspace.
  const [view, setView] = useState<"start" | "workspace">("start");

  // Composer state
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<string[]>([]);
  const [reference, setReference] = useState("us_quarter");
  const [refineDraft, setRefineDraft] = useState("");

  // Conversation + design state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [photos, setPhotos] = useState<string[]>([]); // photos of the original part (used by AI check)
  const [originalPrompt, setOriginalPrompt] = useState("");
  const [part, setPart] = useState<PartMeta | null>(null);
  const [code, setCode] = useState("");
  const [values, setValues] = useState<Record<string, number | boolean>>({});
  const [stl, setStl] = useState<ArrayBuffer | null>(null);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const viewerRef = useRef<ViewerHandle | null>(null);
  const params = useMemo(() => parseParams(code), [code]);
  const say = useCallback((m: Omit<ChatMessage, "id">) => setMessages((ms) => [...ms, { ...m, id: msgId++ }]), []);
  // Only change state if there are overrides, so we don't trigger a redundant re-compile.
  const resetValues = useCallback(() => setValues((v) => (Object.keys(v).length ? {} : v)), []);

  // ---- Compile -------------------------------------------------------------
  const compile = useCallback(async (src: string, defines: Record<string, number | boolean> = {}) => {
    const r = await compileScad(src, defines);
    if (r.ok) {
      setStl(r.stl);
      setCompileError(null);
    } else {
      setCompileError(r.error);
    }
    return r;
  }, []);

  /** Compile; if it fails, ask Gemini to fix the code (up to N times). */
  const compileWithAutoFix = useCallback(
    async (src: string): Promise<boolean> => {
      let current = src;
      for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        setBusy(attempt === 0 ? "Building the 3D model…" : `Fixing a modelling error (attempt ${attempt} of ${MAX_FIX_ATTEMPTS})…`);
        const r = await compile(current);
        if (r.ok) return true;
        if (attempt === MAX_FIX_ATTEMPTS) break;
        try {
          const fixed = await postJson<Part>("/api/refine", { code: current, compileError: r.error });
          current = fixed.scad_code;
          setCode(current);
          resetValues();
        } catch {
          break;
        }
      }
      return false;
    },
    [compile, resetValues],
  );

  // Re-compile (debounced) when sliders change. No AI call needed.
  const firstValues = useRef(true);
  useEffect(() => {
    if (firstValues.current) {
      firstValues.current = false;
      return;
    }
    if (!code) return;
    const t = setTimeout(() => compile(code, values), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const bakedCode = () => applyParams(code, values);

  // ---- Actions -------------------------------------------------------------
  async function startDesign() {
    const text = draft.trim();
    const imgs = draftImages;
    say({ role: "user", text, images: imgs, reference });
    setDraft("");
    setDraftImages([]);
    setBusy("Looking at your photos and designing the part…");
    try {
      const r = await postJson<Part>("/api/generate", { prompt: text, images: imgs, reference });
      const { scad_code, ...meta } = r;
      setPart(meta);
      setPhotos(imgs);
      setOriginalPrompt(text);
      setCode(scad_code);
      resetValues();
      const ok = await compileWithAutoFix(scad_code);
      say({
        role: "assistant",
        text: ok
          ? `${meta.summary}\n\nDrag to rotate the model. Fine-tune sizes under "Adjust dimensions", or tell me what to change.`
          : "I designed the part but couldn't get it to build cleanly. Describe what's wrong, or open the code to take a look.",
        warnings: meta.warnings,
        error: !ok,
      });
      setView("workspace");
    } catch (e) {
      say({ role: "assistant", text: `Something went wrong: ${(e as Error).message}`, error: true });
      // Put the request back in the composer so it's easy to retry.
      setDraft(text);
      setDraftImages(imgs);
    } finally {
      setBusy(null);
    }
  }

  async function refine() {
    const text = refineDraft.trim();
    if (!text) return;
    say({ role: "user", text });
    setRefineDraft("");
    setBusy("Updating the design…");
    try {
      const r = await postJson<Part>("/api/refine", { code: bakedCode(), instruction: text });
      const { scad_code, ...meta } = r;
      setPart((p) => ({ ...meta, title: meta.title || p?.title || "" }));
      setCode(scad_code);
      resetValues();
      const ok = await compileWithAutoFix(scad_code);
      say({
        role: "assistant",
        text: ok ? meta.summary || "Done. The model is updated." : "I made the change but the model won't build. Try rephrasing the request.",
        warnings: meta.warnings,
        error: !ok,
      });
    } catch (e) {
      say({ role: "assistant", text: `Something went wrong: ${(e as Error).message}`, error: true });
      setRefineDraft(text);
    } finally {
      setBusy(null);
    }
  }

  async function aiCheck() {
    if (!viewerRef.current || !stl) return;
    setBusy("Checking the model against your photos…");
    try {
      const renders = await viewerRef.current.capture();
      const r = await postJson<{ matches: boolean; issues: string[]; scad_code: string }>("/api/verify", {
        code: bakedCode(),
        prompt: originalPrompt,
        photos,
        renders,
      });
      if (r.matches) {
        say({ role: "assistant", text: "Checked: the model looks like a good match." + (r.issues.length ? `\n\nNotes: ${r.issues.join("; ")}` : "") });
      } else if (r.scad_code?.trim()) {
        setCode(r.scad_code);
        resetValues();
        const ok = await compileWithAutoFix(r.scad_code);
        say({ role: "assistant", text: `I found some problems and fixed them:\n• ${r.issues.join("\n• ")}`, error: !ok });
      } else {
        say({ role: "assistant", text: `Possible issues:\n• ${r.issues.join("\n• ")}` });
      }
    } catch (e) {
      say({ role: "assistant", text: `Check failed: ${(e as Error).message}`, error: true });
    } finally {
      setBusy(null);
    }
  }

  async function loadSample() {
    setPart({
      title: "Stove knob (sample)",
      summary: "Sample part",
      measurements: [],
      assumptions: [],
    });
    setCode(EXAMPLE_KNOB);
    resetValues();
    setPhotos([]);
    setOriginalPrompt("Stove knob with a D-shaped shaft");
    say({ role: "user", text: "Show me a sample part" });
    setBusy("Building the 3D model…");
    await compile(EXAMPLE_KNOB);
    say({
      role: "assistant",
      text: 'Here\'s a sample stove knob. Open "Adjust dimensions" to change the shaft size, grip count and more, or ask me for a change.',
    });
    setBusy(null);
    setView("workspace");
  }

  function newPart() {
    setView("start");
    setMessages([]);
    setPart(null);
    setCode("");
    setStl(null);
    setInfo(null);
    setPhotos([]);
    setCompileError(null);
    resetValues();
    setRefineDraft("");
  }

  const fileBase = (part?.title || "part").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part";

  // ---- Start screen --------------------------------------------------------
  if (view === "start") {
    const started = messages.length > 0;
    return (
      <div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
        <header className="px-5 py-4">
          <Logo />
        </header>
        <main className={`mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 ${started ? "min-h-0" : "justify-center pb-[12vh]"}`}>
          {started ? (
            <div className="min-h-0 flex-1 overflow-y-auto py-4">
              <ChatThread messages={messages} pending={busy} />
            </div>
          ) : (
            <div className="mb-6 text-center">
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">What do you need to print?</h1>
              <p className="mt-3 text-sm text-slate-400">
                Describe the part and add photos with a coin, bill or ruler next to it for scale.
              </p>
            </div>
          )}

          <div className={started ? "pb-5" : ""}>
            <Composer
              value={draft}
              onChange={setDraft}
              onSubmit={startDesign}
              disabled={!!busy}
              images={draftImages}
              onImagesChange={setDraftImages}
              reference={reference}
              onReferenceChange={setReference}
              allowImageOnly
              autoFocus
              placeholder="e.g. Replacement knob for my stove. The shaft hole cracked. Shaft is about 6 mm."
            />
            {!started && (
              <>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setDraft(s)}
                      className="rounded-full border border-slate-800 px-3 py-1.5 text-xs text-slate-400 hover:border-slate-600 hover:text-slate-200"
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <p className="mt-6 text-center text-xs text-slate-500">
                  Tip: lay the coin flat next to the part and shoot from straight above, then add a side view.{" "}
                  <button onClick={loadSample} className="text-slate-400 underline hover:text-slate-200">
                    Or try a sample part
                  </button>
                </p>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ---- Workspace -----------------------------------------------------------
  return (
    <div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          {part?.title && <span className="truncate text-sm text-slate-400">/ {part.title}</span>}
        </div>
        <button onClick={newPart} disabled={!!busy} className="shrink-0 rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40">
          + New part
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 3D viewer */}
        <main className="relative h-[36vh] shrink-0 sm:h-[42vh] border-b border-slate-800 lg:h-auto lg:flex-1 lg:border-b-0">
          <Viewer stl={stl} handleRef={viewerRef} onInfo={setInfo} />
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-2 p-3">
            {info ? (
              <div data-testid="dims" className="rounded-md bg-black/60 px-3 py-1.5 font-mono text-xs text-slate-200 backdrop-blur">
                {info.x.toFixed(1)} × {info.y.toFixed(1)} × {info.z.toFixed(1)} mm
                <span className="ml-2 hidden text-slate-500 sm:inline">grid 10 mm</span>
              </div>
            ) : (
              <span />
            )}
            <div className="pointer-events-auto flex gap-2">
              <button
                onClick={aiCheck}
                disabled={!!busy || !stl}
                className="rounded-md bg-black/60 px-3 py-1.5 text-xs text-sky-300 backdrop-blur hover:bg-black/80 disabled:opacity-40"
                title="Render the model from 4 angles and have Gemini compare it to your photos"
              >
                ✓ AI check
              </button>
            </div>
          </div>
          {busy && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
              <div className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-amber-300 backdrop-blur">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                {busy}
              </div>
            </div>
          )}
          {compileError && !busy && (
            <pre className="absolute inset-x-3 bottom-3 max-h-32 overflow-auto rounded-md border border-red-900 bg-red-950/90 p-3 text-xs text-red-200">
              {compileError}
            </pre>
          )}
        </main>

        {/* Side panel */}
        <aside className="flex min-h-0 w-full flex-1 flex-col border-slate-800 lg:w-[420px] lg:flex-none lg:border-l">
          <div className="border-b border-slate-800 p-3 sm:p-4">
            <button
              onClick={() => stl && downloadBlob(stl, `${fileBase}.stl`, "model/stl")}
              disabled={!stl || !!compileError}
              className="flex w-full items-center justify-center gap-3 rounded-xl bg-amber-500 px-4 py-3 sm:py-3.5 text-slate-950 shadow-lg shadow-amber-500/10 transition hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:shadow-none"
            >
              <DownloadIcon />
              <span className="text-left">
                <span className="block text-base font-semibold leading-tight">Download STL</span>
                <span className="block text-xs opacity-75">
                  Print-ready{info ? ` · ${info.x.toFixed(0)} × ${info.y.toFixed(0)} × ${info.z.toFixed(0)} mm` : ""}
                </span>
              </span>
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {params.length > 0 && (
              <Collapsible
                title="Adjust dimensions"
                badge={`${params.length}`}
                hint="Instant. Use calipers for tight fits."
              >
                <ParamPanel params={params} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} />
                {Object.keys(values).length > 0 && (
                  <button onClick={resetValues} className="mt-3 text-xs text-slate-400 underline">
                    Reset to designed values
                  </button>
                )}
              </Collapsible>
            )}

            {part && (part.measurements.length > 0 || part.assumptions.length > 0) && (
              <Collapsible title="Measurements & assumptions" badge={`${part.measurements.length}`}>
                {part.measurements.length > 0 && (
                  <table className="w-full text-xs">
                    <tbody>
                      {part.measurements.map((m, i) => (
                        <tr key={i} className="border-t border-slate-800 first:border-t-0">
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
                {part.assumptions.length > 0 && (
                  <ul className="mt-3 list-disc space-y-0.5 pl-4 text-xs text-slate-400">
                    {part.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
              </Collapsible>
            )}

            <Collapsible title="OpenSCAD code">
              <textarea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                spellCheck={false}
                rows={14}
                aria-label="OpenSCAD code"
                className="w-full rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-[11px] leading-relaxed"
              />
              <div className="mt-2 flex justify-between">
                <button onClick={() => downloadBlob(bakedCode(), `${fileBase}.scad`, "text/plain")} className="text-xs text-slate-400 underline">
                  Download .scad
                </button>
                <button
                  onClick={async () => {
                    resetValues();
                    setBusy("Building the 3D model…");
                    await compile(code);
                    setBusy(null);
                  }}
                  disabled={!!busy}
                  className="rounded bg-slate-700 px-3 py-1 text-xs hover:bg-slate-600"
                >
                  Rebuild
                </button>
              </div>
            </Collapsible>

            <div className="pt-2">
              <ChatThread messages={messages} pending={busy} />
            </div>
          </div>

          <div className="border-t border-slate-800 p-3">
            <Composer
              size="sm"
              value={refineDraft}
              onChange={setRefineDraft}
              onSubmit={refine}
              disabled={!!busy}
              placeholder="Ask for a change, e.g. make the hole 0.5 mm bigger"
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function Collapsible({ title, badge, hint, children }: { title: string; badge?: string; hint?: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-slate-800 bg-slate-900/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm text-slate-200 [&::-webkit-details-marker]:hidden">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-slate-500 transition-transform group-open:rotate-90" aria-hidden>
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className="font-medium">{title}</span>
        {badge && <span className="rounded-full bg-slate-800 px-1.5 text-[10px] text-slate-400">{badge}</span>}
        {hint && <span className="ml-auto hidden text-[11px] text-slate-500 group-open:inline">{hint}</span>}
      </summary>
      <div className="border-t border-slate-800 px-3 py-3">{children}</div>
    </details>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="grid h-7 w-7 place-items-center rounded-lg bg-amber-500 text-slate-950" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
          <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
          <path d="m3 7 9 5 9-5M12 12v10" />
        </svg>
      </div>
      <span className="font-semibold tracking-tight">vibe3d</span>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
    </svg>
  );
}

function confColor(c: string) {
  if (c === "high") return "bg-emerald-900 text-emerald-200";
  if (c === "medium") return "bg-amber-900 text-amber-200";
  return "bg-red-900 text-red-200";
}
