import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import os from "os";
import {
  MODEL,
  dataUrlToPart,
  errorResponse,
  generateJson,
  HttpError,
  MATING_PART_SCHEMA,
  type MatingPartExtraction,
} from "@/lib/gemini";
import type { PhysicsSpec } from "@/lib/client";
import type { Part } from "@google/genai";

export const maxDuration = 120;

type Body = {
  stlBase64?: string;
  stlPath?: string;
  code?: string;
  prompt?: string;
  photos?: string[];
  physics?: PhysicsSpec;
};

export async function POST(req: Request) {
  let tmpDir: string | null = null;
  try {
    const body = (await req.json()) as Body;
    if (!body.stlBase64 && !body.stlPath) {
      throw new HttpError(400, "Missing STL data for physics verification.");
    }

    // Step 1: Extract Part 2 (Mating fixture) from photos and Part 1 design
    let mating: MatingPartExtraction | null = null;
    if (process.env.GEMINI_API_KEY && ((body.photos && body.photos.length > 0) || body.prompt)) {
      try {
        const parts: Part[] = [];
        if (body.photos && body.photos.length > 0) {
          parts.push({ text: "PHOTO(S) of the part and its mating assembly:" });
          parts.push(...body.photos.slice(0, 4).map(dataUrlToPart));
        }
        parts.push({
          text: [
            `User request: ${body.prompt || "Replacement part"}`,
            `Current Part 1 OpenSCAD code:\n\`\`\`openscad\n${body.code || ""}\n\`\`\``,
            "Analyze the photo(s) and Part 1 design to identify the TWO PARTS for physical verification:",
            "1. Part 1: The replacement part designed above.",
            "2. Part 2: The mating part / fixture / host interface visible or implied in the picture (e.g. stove valve stem, pen cartridge/core, hinge pin, axle, slot).",
            "Generate clean OpenSCAD code for Part 2 positioned so Part 1 mates cleanly with it.",
            "Autodetect relative motion (sliding, rotating, or static) and fit preference (snug, smooth, or loose).",
          ].join("\n"),
        });

        mating = await generateJson<MatingPartExtraction>({
          model: MODEL,
          parts,
          schema: MATING_PART_SCHEMA,
        });
      } catch (err) {
        console.warn("Could not extract Part 2 with Gemini, using fallback:", err);
      }
    }

    // Fallback if no extraction occurred
    if (!mating) {
      const p = body.physics || {
        motion: "rotating",
        fit_preference: "snug",
        mating_part: { type: "d_shaft", primary_dim_mm: 6.0, depth_mm: 14.0 },
      };
      mating = {
        part1_name: "Replacement Part (Part 1)",
        part2_name: `${p.mating_part?.type || "shaft"} fixture (Part 2)`,
        description: `Two-body ${p.motion} interface with ${p.fit_preference} fit.`,
        motion: p.motion,
        fit_preference: p.fit_preference,
        part2_scad: `// Parametric mating fixture\ncylinder(d=${p.mating_part?.primary_dim_mm || 6}, h=${p.mating_part?.depth_mm || 15}, $fn=48);`,
        primary_dim_mm: p.mating_part?.primary_dim_mm || 6.0,
        depth_mm: p.mating_part?.depth_mm || 15.0,
      };
    }

    // Step 2: Compile Part 2 OpenSCAD to STL if available
    let part2StlPath: string | null = null;
    if (mating.part2_scad?.trim()) {
      try {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe3d-"));
        const scadFile = path.join(tmpDir, "part2.scad");
        const stlFile = path.join(tmpDir, "part2.stl");
        await fs.writeFile(scadFile, mating.part2_scad);

        await new Promise<void>((resolve, reject) => {
          const cp = spawn("openscad", ["--export-format", "binstl", "-o", stlFile, scadFile]);
          cp.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`OpenSCAD compile exited with code ${code}`));
          });
        });

        if (
          await fs
            .stat(stlFile)
            .then(() => true)
            .catch(() => false)
        ) {
          part2StlPath = stlFile;
        }
      } catch (e) {
        console.warn("Could not compile Part 2 STL:", e);
      }
    }

    // Step 3: Run the two-body simulation in MuJoCo
    const scriptPath = path.join(process.cwd(), "scripts", "verify_physics.py");
    const payload = JSON.stringify({
      stl_base64: body.stlBase64,
      stl_path: body.stlPath,
      part2_stl: part2StlPath,
      physics: {
        motion: mating.motion,
        fit_preference: mating.fit_preference,
        mating_part: {
          type: mating.part2_name.toLowerCase().includes("d_shaft") || mating.part2_name.toLowerCase().includes("d-shaft") ? "d_shaft" : "round_shaft",
          primary_dim_mm: mating.primary_dim_mm,
          depth_mm: mating.depth_mm || 15.0,
        },
      },
    });

    const report = await new Promise<string>((resolve, reject) => {
      const child = spawn("python3", [scriptPath, payload]);
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("close", (code) => {
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(stderr || `MuJoCo runner exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });
    });

    const parsed = JSON.parse(report);
    return Response.json({
      ...parsed,
      part1_name: mating.part1_name,
      part2_name: mating.part2_name,
      description: mating.description,
      part2_scad: mating.part2_scad,
    });
  } catch (err) {
    return errorResponse(err);
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
    }
  }
}
