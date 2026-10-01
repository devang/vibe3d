import { FAST_MODEL, MODEL, errorResponse, generateJson, PART_SCHEMA, HttpError, type PartResult } from "@/lib/gemini";

export const maxDuration = 120;

type Body = {
  code: string;
  instruction?: string; // user edit request, e.g. "make the hole 1mm bigger"
  compileError?: string; // OpenSCAD stderr when the last compile failed
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.code?.trim()) throw new HttpError(400, "Missing current code.");
    if (!body.instruction?.trim() && !body.compileError?.trim()) {
      throw new HttpError(400, "Provide an instruction or a compile error.");
    }

    const task = body.compileError
      ? `The OpenSCAD code below failed to compile. Fix it with the smallest change that keeps the design intent.\n\nOpenSCAD output:\n${body.compileError.slice(-4000)}`
      : `Modify the design: ${body.instruction}\nKeep all existing parameters unless the change requires otherwise. Keep the Customizer comment format.`;

    const result = await generateJson<PartResult>({
      // Compile fixes are cheap; design edits get the stronger model.
      model: body.compileError ? FAST_MODEL : MODEL,
      parts: [{ text: `${task}\n\nCurrent code:\n\`\`\`openscad\n${body.code}\n\`\`\`` }],
      schema: PART_SCHEMA,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
