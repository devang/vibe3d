export type ScadParam = {
  name: string;
  type: "number" | "boolean";
  value: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
  group?: string;
};

const ASSIGN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?|true|false)\s*;\s*(?:\/\/\s*(.*))?$/;
const RANGE = /^\[\s*(-?\d+(?:\.\d+)?)\s*(?::\s*(-?\d+(?:\.\d+)?))?\s*(?::\s*(-?\d+(?:\.\d+)?))?\s*\]\s*(.*)$/;

/**
 * Parses OpenSCAD Customizer-style parameters from the top of a file:
 *   knob_diameter = 38; // [10:0.5:80] Outer diameter
 * Stops at the first module/function definition or a "/* [Hidden] *\/" marker.
 */
export function parseParams(code: string): ScadParam[] {
  const params: ScadParam[] = [];
  let group: string | undefined;
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (/^\/\*\s*\[\s*hidden\s*\]\s*\*\//i.test(line)) break;
    if (/^(module|function)\s/.test(line)) break;
    const g = /^\/\*\s*\[\s*([^\]]+)\s*\]\s*\*\//.exec(line);
    if (g) {
      group = g[1];
      continue;
    }
    const m = ASSIGN.exec(line);
    if (!m) continue;
    const [, name, rawVal, comment = ""] = m;
    if (name.startsWith("$") ) continue;
    if (rawVal === "true" || rawVal === "false") {
      params.push({ name, type: "boolean", value: rawVal === "true", description: comment.trim() || undefined, group });
      continue;
    }
    const value = Number(rawVal);
    const p: ScadParam = { name, type: "number", value, group };
    const r = RANGE.exec(comment.trim());
    if (r) {
      // OpenSCAD: [max] | [min:max] | [min:step:max]
      const a = Number(r[1]);
      if (r[3] !== undefined) {
        p.min = a; p.step = Number(r[2]); p.max = Number(r[3]);
      } else if (r[2] !== undefined) {
        p.min = a; p.max = Number(r[2]);
      } else {
        p.min = 0; p.max = a;
      }
      p.description = r[4]?.trim() || undefined;
    } else {
      p.description = comment.trim() || undefined;
    }
    if (p.min === undefined) {
      const mag = Math.max(Math.abs(value), 1);
      p.min = value >= 0 ? 0 : -mag * 3;
      p.max = mag * 3;
    }
    p.step ??= Number.isInteger(value) && (p.max! - p.min!) > 20 ? 1 : 0.1;
    params.push(p);
  }
  return params;
}

/** Bake current parameter values back into the source (for download / sending to the AI). */
export function applyParams(code: string, values: Record<string, number | boolean>): string {
  return code
    .split("\n")
    .map((line) => {
      const m = ASSIGN.exec(line);
      if (!m || !(m[1] in values)) return line;
      return line.replace(/=\s*(-?\d+(?:\.\d+)?|true|false)\s*;/, `= ${values[m[1]]};`);
    })
    .join("\n");
}
