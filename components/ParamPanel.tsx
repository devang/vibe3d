"use client";

import type { ScadParam } from "@/lib/scad/params";

export default function ParamPanel({
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
            {header && <div className="mb-1 mt-3 text-[11px] uppercase tracking-wider text-slate-500 first:mt-0">{header}</div>}
            {p.type === "boolean" ? (
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={v as boolean} onChange={(e) => onChange(p.name, e.target.checked)} />
                {p.description || p.name}
              </label>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-slate-300" title={p.name}>
                    {p.description || p.name}
                  </span>
                  <input
                    type="number"
                    value={v as number}
                    step={p.step}
                    onChange={(e) => e.target.value !== "" && onChange(p.name, Number(e.target.value))}
                    className="w-20 shrink-0 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-right font-mono"
                    aria-label={p.description || p.name}
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
                  aria-label={`${p.description || p.name} slider`}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
