// Shared client-side types and helpers.

export type Part = {
  title: string;
  summary: string;
  measurements: { name: string; value_mm: number; confidence: string; note?: string }[];
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
