import { MODEL, dataUrlToPart, errorResponse, generateJson, VERIFY_SCHEMA, HttpError } from "@/lib/gemini";
import type { Part } from "@google/genai";

export const maxDuration = 120;

type Body = {
  code: string;
  prompt?: string;
  photos?: string[]; // original user photos (data URLs)
  renders: string[]; // screenshots of the compiled model from several angles
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.code?.trim() || !body.renders?.length) throw new HttpError(400, "Missing code or renders.");

    const parts: Part[] = [];
    if (body.photos?.length) {
      parts.push({ text: "ORIGINAL PHOTO(S) of the part the user wants:" });
      parts.push(...body.photos.slice(0, 4).map(dataUrlToPart));
    }
    parts.push({ text: "RENDERS of the generated model (front, side, top, isometric). The grid is 10 mm per cell:" });
    parts.push(...body.renders.slice(0, 4).map(dataUrlToPart));
    parts.push({
      text: [
        `User request: ${body.prompt || "(none, photo only)"}`,
        "Compare the renders against the request/photos. Check: overall shape, feature count and placement (holes, slots, tabs),",
        "proportions, orientation on the bed, and printability. Ignore colour and surface finish.",
        "If it is a good match, set matches=true and scad_code to an empty string.",
        "Otherwise list the issues and return corrected full OpenSCAD code (same parameter format).",
        `\nCode:\n\`\`\`openscad\n${body.code}\n\`\`\``,
      ].join("\n"),
    });

    const result = await generateJson<{ matches: boolean; issues: string[]; scad_code: string }>({
      model: MODEL,
      parts,
      schema: VERIFY_SCHEMA,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
