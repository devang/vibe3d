# vibe3d

Turn a photo of a broken part into a printable replacement.

Upload photos with a coin, bill or card for scale and describe the part. Gemini estimates the dimensions and writes **parametric OpenSCAD**. The code compiles to STL **in your browser** (OpenSCAD WASM) and appears in a three.js viewer. From there you can tweak dimensions with sliders, which takes no AI call, ask for changes in plain English, or run an **AI check** that renders the model from 4 angles and has Gemini compare it to your photos.

## Quick start

```bash
npm install            # also copies the OpenSCAD WASM bundle into public/vendor
cp .env.example .env.local
# put your key from https://aistudio.google.com/apikey into .env.local
npm run dev
```

Open http://localhost:3000. A sample stove knob loads right away, so the viewer and sliders work even before you add an API key.

## How it works

```
photos + prompt ─► /api/generate (Gemini, structured JSON) ─► OpenSCAD code + measurements
                                                     │
                    browser Web Worker (OpenSCAD WASM)◄┘
                     │ compile error? ─► /api/refine (fast model) ─► retry, up to 3×
                     ▼
                   STL ─► three.js viewer ─► sliders recompile locally (-D overrides)
                     │
                     ├─► "AI check": 4 renders + photos ─► /api/verify ─► fixed code if needed
                     │
                     └─► "Verify physics": 2-body simulation ─► /api/verify-physics (MuJoCo) ─► fit & clearance
```

| Path | What it does |
| --- | --- |
| `app/page.tsx` | The whole UI: photo upload, reference picker, parameters, refine, code editor, physics check |
| `components/Viewer.tsx` | three.js / react-three-fiber STL viewer with a 10 mm grid and 4-angle capture |
| `public/scad-worker.js` | Module Web Worker that runs OpenSCAD WASM (Manifold backend) and returns binary STL |
| `lib/scad/compile.ts` | Promise wrapper around the worker |
| `lib/scad/params.ts` | Parses Customizer-style `name = 10; // [min:step:max] desc` lines into sliders |
| `lib/gemini.ts` | Gemini client, style guide, schemas (including auto-detected physics & fit preferences) |
| `scripts/verify_physics.py` | Two-body MuJoCo physics verification engine using local dynamic library |
| `app/api/{generate,refine,verify,verify-physics}` | Server routes. The API key never reaches the browser |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Required for AI features |
| `GEMINI_MODEL` | `gemini-3.1-pro-preview` | Photo → part generation, design edits, visual check |
| `GEMINI_FAST_MODEL` | `gemini-3.8-flash` | Compile-error fixes |

## Deploying

Works on Vercel or any Node host. OpenSCAD runs in the browser, so the server only makes Gemini calls. The API routes set `maxDuration = 120` because Pro calls with images can be slow.

Before going public, add authentication and rate limiting to `/api/*`. Image calls to Pro models cost real money.

## Known limitations / next steps

- `text()` doesn't work because the WASM build ships no fonts.
- Measurements from photos are estimates (±0.5–1 mm). The UI shows the model's confidence for each measurement. For tight fits, measure with calipers and enter the values in "Known measurements".
- Ideas: a printable "fit test" slice of the critical feature, print-readiness checks (thin walls, overhangs), tolerance presets per material, version history and undo, and exporting to a slicer.
