import "server-only";
import { GoogleGenAI, type Part } from "@google/genai";

export const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
export const FAST_MODEL = process.env.GEMINI_FAST_MODEL || "gemini-3.8-flash";

let client: GoogleGenAI | null = null;
export function gemini() {
  if (!process.env.GEMINI_API_KEY) {
    throw new HttpError(500, "GEMINI_API_KEY is not set. Copy .env.example to .env.local and add your key.");
  }
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const REFERENCE_OBJECTS: Record<string, string> = {
  none: "No reference object in the photo. Estimate size from context and the user's description, and mark measurements as low confidence.",
  us_quarter: "A US quarter is in frame: diameter 24.26 mm, thickness 1.75 mm.",
  us_penny: "A US penny is in frame: diameter 19.05 mm, thickness 1.52 mm.",
  us_dollar: "A US dollar bill is in frame: 155.96 mm x 66.29 mm.",
  credit_card: "A standard credit/ID card is in frame: 85.60 mm x 53.98 mm, 0.76 mm thick.",
  ruler: "A ruler with mm/cm or inch markings is in frame; read scale directly from its markings.",
};

export const SCAD_STYLE_GUIDE = `You are an expert mechanical designer who writes OpenSCAD for FDM 3D printing.
You design replacement parts and functional objects from photos and descriptions.

OpenSCAD rules (the code is compiled by OpenSCAD 2025 WASM with the Manifold backend):
- Units are millimetres.
- Put EVERY meaningful dimension in a named top-level variable at the top of the file, BEFORE any module or geometry.
  Use this exact Customizer format so the UI can build sliders:
    // Section name
    knob_diameter = 38; // [10:0.5:80] Outer diameter of the knob
  Each variable: a number (or true/false), then a comment with [min:step:max] and a short description.
  Only plain numbers or booleans on those lines, never expressions. Derived values go below a line "/* [Hidden] */".
- Add clearance to holes, shafts and mating features (default 0.2 mm per side unless told otherwise). Expose it as a parameter named "clearance".
- Use $fn = 96 for round features (also a parameter).
- Produce exactly ONE printable solid, oriented to sit flat on the build plate (z=0) with minimal overhangs/supports.
- Avoid features thinner than 1.2 mm. Avoid text() (no fonts are available). Do not use include/use of external libraries.
- Keep code clean and commented. No echo spam.

Measurement rules:
- When a reference object is present, use it to estimate scale. Correct for perspective where possible.
- List every key measurement you used with a confidence (high/medium/low). Be honest: photo estimates are typically +/-0.5-1 mm.
- List assumptions (e.g. hidden faces, symmetry, material).
- If the part is safety-critical, load-bearing, heat-exposed or food-contact, say so in "warnings".

Physics & Functional Interface rules:
- Identify the primary mating interface for the replacement part.
- Autodetect the relative motion: "sliding" (pushed onto a shaft/track/peg), "rotating" (turns or pivots like a knob, wheel, or hinge), or "static" (flat bracket, cover, or spacer).
- Autodetect the fit preference: "snug" (press-fit to grip without slipping, e.g. knob on shaft), "smooth" (slides/rotates easily by hand with gentle friction), or "loose" (free-spinning or drop-in clearance).
- Specify the mating part geometry (d_shaft, round_shaft, pin, slot, flat_ground) and its primary dimension in mm.
  For a D-shaft also give flat_mm (distance from the flat to the opposite side).
- Put the mating hole/socket on the Z axis (x = y = 0), opening on the bottom face (z = 0) where possible,
  so the in-browser fit check can find it.`;

export const PART_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short name for the part" },
    summary: { type: "string", description: "One or two sentences describing what was designed" },
    measurements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value_mm: { type: "number" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          note: { type: "string" },
        },
        required: ["name", "value_mm", "confidence"],
      },
    },
    physics: {
      type: "object",
      description: "Auto-detected physical interaction and fit preference with mating fixture",
      properties: {
        motion: { type: "string", enum: ["sliding", "rotating", "static"] },
        fit_preference: { type: "string", enum: ["snug", "smooth", "loose"] },
        mating_part: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["d_shaft", "round_shaft", "pin", "slot", "flat_ground"] },
            primary_dim_mm: { type: "number" },
            depth_mm: { type: "number" },
            flat_mm: { type: "number", description: "D-shafts only: distance from the flat to the opposite side" },
          },
          required: ["type", "primary_dim_mm"],
        },
      },
      required: ["motion", "fit_preference", "mating_part"],
    },
    assumptions: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    scad_code: { type: "string", description: "Complete OpenSCAD source" },
  },
  required: ["title", "summary", "measurements", "physics", "assumptions", "scad_code"],
} as const;

export const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    matches: { type: "boolean", description: "true if the rendered model is a plausible, printable match for the request" },
    issues: { type: "array", items: { type: "string" } },
    scad_code: { type: "string", description: "Corrected full OpenSCAD source if matches is false; otherwise empty string" },
  },
  required: ["matches", "issues", "scad_code"],
} as const;

export const MATING_PART_SCHEMA = {
  type: "object",
  properties: {
    part1_name: { type: "string", description: "Name of the generated replacement part (Part 1)" },
    part2_name: { type: "string", description: "Name of the mating part / host fixture identified from the photo/context (Part 2)" },
    description: { type: "string", description: "Explanation of how Part 1 and Part 2 mate physically" },
    motion: { type: "string", enum: ["sliding", "rotating", "static"], description: "Relative motion between Part 1 and Part 2" },
    fit_preference: { type: "string", enum: ["snug", "smooth", "loose"], description: "Target fit feel: snug (press-fit), smooth (hand slide/glide), or loose" },
    mating_type: { type: "string", enum: ["d_shaft", "round_shaft", "pin", "slot", "flat_ground"], description: "Shape of Part 2's mating feature" },
    part2_scad: {
      type: "string",
      description:
        "Clean, self-contained OpenSCAD code for Part 2 (the mating fixture) at nominal size, with NO clearance added. Model only the mating feature and a little of what it is attached to. Point the mating end straight up (+Z) along the Z axis.",
    },
    primary_dim_mm: { type: "number", description: "Key mating interface dimension in mm (e.g. shaft diameter, pin size)" },
    depth_mm: { type: "number", description: "Mating insertion depth or overlap in mm" },
    flat_mm: { type: "number", description: "D-shafts only: distance from the flat to the opposite side" },
  },
  required: ["part1_name", "part2_name", "description", "motion", "fit_preference", "mating_type", "part2_scad", "primary_dim_mm"],
} as const;

export type MatingPartExtraction = {
  part1_name: string;
  part2_name: string;
  description: string;
  motion: "sliding" | "rotating" | "static";
  fit_preference: "snug" | "smooth" | "loose";
  mating_type?: "d_shaft" | "round_shaft" | "pin" | "slot" | "flat_ground";
  part2_scad: string;
  primary_dim_mm: number;
  depth_mm?: number;
  flat_mm?: number;
};

export type PhysicsSpec = {
  motion: "sliding" | "rotating" | "static";
  fit_preference: "snug" | "smooth" | "loose";
  mating_part: {
    type: "d_shaft" | "round_shaft" | "pin" | "slot" | "flat_ground";
    primary_dim_mm: number;
    depth_mm?: number;
    flat_mm?: number;
  };
};

export type PartResult = {
  title: string;
  summary: string;
  measurements: { name: string; value_mm: number; confidence: string; note?: string }[];
  physics?: PhysicsSpec;
  assumptions: string[];
  warnings?: string[];
  scad_code: string;
};

export async function generateJson<T>(opts: {
  model: string;
  parts: Part[];
  schema: object;
  system?: string;
}): Promise<T> {
  const res = await gemini().models.generateContent({
    model: opts.model,
    contents: [{ role: "user", parts: opts.parts }],
    config: {
      systemInstruction: opts.system ?? SCAD_STYLE_GUIDE,
      responseMimeType: "application/json",
      responseJsonSchema: opts.schema,
    },
  });
  const text = res.text;
  if (!text) throw new HttpError(502, "Gemini returned an empty response.");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(502, "Gemini returned invalid JSON.");
  }
}

/** data:image/png;base64,.... -> inlineData part */
export function dataUrlToPart(dataUrl: string): Part {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new HttpError(400, "Invalid image data URL.");
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

export function errorResponse(err: unknown) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error("[api]", message);
  return Response.json({ error: message }, { status });
}
