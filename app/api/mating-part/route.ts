import { MODEL, dataUrlToPart, errorResponse, generateJson, HttpError, MATING_PART_SCHEMA, type MatingPartExtraction } from "@/lib/gemini";
import type { Part } from "@google/genai";

export const maxDuration = 120;

type Body = {
  code?: string;
  prompt?: string;
  photos?: string[]; // small data URLs
};

/**
 * Asks Gemini to identify Part 2 (the shaft, stem, pin... that the generated part mates with)
 * from the photos and the part's code, and to model it in OpenSCAD. The browser compiles it and
 * runs the fit check itself (see public/physics/fit-check.js), so nothing else runs on the server.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.code?.trim()) throw new HttpError(400, "Missing the part's OpenSCAD code.");

    const parts: Part[] = [];
    if (body.photos?.length) {
      parts.push({ text: "PHOTO(S) of the part and what it mates with:" });
      parts.push(...body.photos.slice(0, 4).map(dataUrlToPart));
    }
    parts.push({
      text: [
        `User request: ${body.prompt || "Replacement part"}`,
        `Part 1 (the replacement part) OpenSCAD code:\n\`\`\`openscad\n${body.code}\n\`\`\``,
        "Identify the TWO PARTS for a physical fit check:",
        "1. Part 1: the replacement part designed above.",
        "2. Part 2: the part it mates with, visible or implied in the photos (e.g. stove valve stem, hinge pin, axle, peg, key).",
        "Write OpenSCAD for Part 2 at its real nominal size. Do NOT add clearance; that belongs in Part 1.",
        "Model just the mating feature (and a short stub of what it is attached to), with the mating end pointing up (+Z).",
        "Detect the relative motion (sliding, rotating or static) and the fit preference (snug, smooth or loose).",
      ].join("\n"),
    });

    const mating = await generateJson<MatingPartExtraction>({ model: MODEL, parts, schema: MATING_PART_SCHEMA });
    return Response.json(mating);
  } catch (err) {
    return errorResponse(err);
  }
}
