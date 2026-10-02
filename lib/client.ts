// Shared client-side types and helpers.

export type MatingType = "d_shaft" | "round_shaft" | "pin" | "slot" | "flat_ground";

export type PhysicsSpec = {
  motion: "sliding" | "rotating" | "static";
  fit_preference: "snug" | "smooth" | "loose";
  mating_part: {
    type: MatingType;
    primary_dim_mm: number;
    depth_mm?: number;
    /** D-shafts: distance from the flat to the opposite side. */
    flat_mm?: number;
  };
};

/** Result of the in-browser fit check (public/physics/fit-check.js). */
export type PhysicsReport = {
  passed: boolean;
  part1_name?: string;
  part2_name?: string;
  description?: string;
  part2_scad?: string;
  /** "photo" when Part 2 was modelled from the photos, "standard" for a generic shaft/pin. */
  part2_source?: "photo" | "standard";
  motion: string;
  fit_preference: string;
  mating_part?: { type: string; primary_dim_mm: number; depth_mm?: number; flat_mm?: number };
  criteria?: { min_clearance_mm: number; max_clearance_mm: number; description: string };
  metrics?: {
    clearance_per_side_mm?: number;
    clearance_change_needed_mm?: number;
    socket_depth_mm?: number;
    through_hole?: boolean;
    engagement_mm?: number;
    orientation_deg?: number;
    wobble_tilt_deg?: number;
    wobble_shift_mm?: number;
    twist_deg?: number;
    slide_travel_mm?: number;
    tip_angle_deg?: number;
    final_tilt_deg?: number;
    simulation_stable?: boolean;
    pieces?: number;
    fixture?: string;
    runtime_ms?: number;
  };
  notes?: string[];
  issues?: string[];
  recommendations?: string[];
  error?: string;
};

export type Part = {
  title: string;
  summary: string;
  measurements: { name: string; value_mm: number; confidence: string; note?: string }[];
  physics?: PhysicsSpec;
  assumptions: string[];
  warnings?: string[];
  scad_code: string;
};

export type PartMeta = Omit<Part, "scad_code">;

export type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  images?: string[];
  reference?: string;
  warnings?: string[];
  error?: boolean;
};

export const REFERENCES = [
  { key: "us_quarter", label: "US quarter", detail: "24.26 mm" },
  { key: "us_penny", label: "US penny", detail: "19.05 mm" },
  { key: "us_dollar", label: "Dollar bill", detail: "156 × 66 mm" },
  { key: "credit_card", label: "Credit card", detail: "85.6 × 54 mm" },
  { key: "ruler", label: "Ruler", detail: "markings" },
  { key: "none", label: "No reference", detail: "" },
] as const;

export function referenceLabel(key?: string) {
  return REFERENCES.find((r) => r.key === key)?.label ?? "No reference";
}

export const MAX_IMAGES = 4;

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}
