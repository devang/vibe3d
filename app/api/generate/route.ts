import { MODEL, REFERENCE_OBJECTS, dataUrlToPart, errorResponse, generateJson, PART_SCHEMA, HttpError, type PartResult } from "@/lib/gemini";
import type { Part } from "@google/genai";

export const maxDuration = 120;

type Body = {
  prompt: string;
  images?: string[]; // data URLs, already resized client-side
  reference?: string; // key of REFERENCE_OBJECTS
  knownMeasurements?: string; // free text from the user, e.g. "shaft is 6mm D-shaped"
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.prompt?.trim() && !body.images?.length) {
      throw new HttpError(400, "Add a description or at least one photo.");
    }
    if ((body.images?.length ?? 0) > 4) throw new HttpError(400, "Up to 4 photos.");

    const ref = REFERENCE_OBJECTS[body.reference ?? "none"] ?? REFERENCE_OBJECTS.none;
    const parts: Part[] = [
      ...(body.images ?? []).map(dataUrlToPart),
      {
        text: [
          `Design request: ${body.prompt || "Recreate the part shown in the photo(s) as a printable replacement."}`,
          `Scale reference: ${ref}`,
          body.knownMeasurements?.trim()
            ? `User-measured dimensions (trust these over photo estimates): ${body.knownMeasurements}`
            : "",
          "Return the measurements you used, your assumptions, any warnings, and the complete OpenSCAD code.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];

    const result = await generateJson<PartResult>({ model: MODEL, parts, schema: PART_SCHEMA });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
