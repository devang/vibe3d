import { spawn } from "child_process";
import path from "path";
import { errorResponse, HttpError } from "@/lib/gemini";
import type { PhysicsSpec } from "@/lib/client";

export const maxDuration = 60;

type Body = {
  stlBase64?: string;
  stlPath?: string;
  physics: PhysicsSpec;
  prompt?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.stlBase64 && !body.stlPath) {
      throw new HttpError(400, "Missing STL data for physics verification.");
    }

    const scriptPath = path.join(process.cwd(), "scripts", "verify_physics.py");
    const payload = JSON.stringify({
      stl_base64: body.stlBase64,
      stl_path: body.stlPath,
      physics: body.physics,
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
    return Response.json(parsed);
  } catch (err) {
    return errorResponse(err);
  }
}
