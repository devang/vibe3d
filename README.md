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
                     └─► "Verify physics": /api/mating-part (Gemini models Part 2 from the photos)
                              ─► browser Web Worker: manifold-3d measures clearance, MuJoCo WASM simulates the fit
```

| Path | What it does |
| --- | --- |
| `app/page.tsx` | The whole UI: photo upload, reference picker, parameters, refine, code editor, physics check |
| `components/Viewer.tsx` | three.js / react-three-fiber STL viewer with a 10 mm grid and 4-angle capture |
| `public/scad-worker.js` | Module Web Worker that runs OpenSCAD WASM (Manifold backend) and returns binary STL |
| `lib/scad/compile.ts` | Promise wrapper around the worker |
| `lib/scad/params.ts` | Parses Customizer-style `name = 10; // [min:step:max] desc` lines into sliders |
| `lib/gemini.ts` | Gemini client, style guide, schemas (including auto-detected physics & fit preferences) |
| `public/physics/fit-check.js` | Two-body fit check: finds the socket, measures clearance/interference with manifold-3d, then simulates seating, wobble, twist and sliding in MuJoCo |
| `public/physics-worker.js`, `lib/physics.ts` | Runs the fit check in a Web Worker (MuJoCo + Manifold WASM, all in the browser) |
| `scripts/copy-wasm.mjs` | Copies the OpenSCAD, MuJoCo and Manifold WASM builds into `public/vendor` on install |
| `app/api/{generate,refine,verify,mating-part}` | Server routes (Gemini only). The API key never reaches the browser |

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Required for AI features |
| `GEMINI_MODEL` | `gemini-3.1-pro-preview` | Photo → part generation, design edits, visual check |
| `GEMINI_FAST_MODEL` | `gemini-3.8-flash` | Compile-error fixes |

## Deploying

Works on Vercel or any Node host. OpenSCAD runs in the browser, so the server only makes Gemini calls. The API routes set `maxDuration = 120` because Pro calls with images can be slow.

Before going public, add authentication and rate limiting to `/api/*`. Image calls to Pro models cost real money.

## How the physics check works

1. **Part 2:** Gemini models the mating part (stem, shaft, pin...) from the photos in OpenSCAD, and the browser compiles it. Without an API key it falls back to a standard shaft from the part's physics spec.
2. **Geometry:** manifold-3d finds the socket in Part 1 (from either face, on the Z axis), lines Part 2 up with it (rotation for D-flats/keys, centring), then measures the exact clearance (`minGap`) or interference (by offsetting Part 2's profile until it clears).
3. **Dynamics:** MuJoCo collides meshes as convex hulls, which would fill in holes. So Part 1 is cut into 24 wedges around the socket axis and Part 2 into 1.5 mm slabs, each nearly convex. The simulation then seats the part, wiggles it, twists it (backlash / free spin) and pushes it on (sliding parts). Static parts get a drop test plus a tipping-angle calculation.
4. Fit targets (designed clearance per side): snug −0.05–0.25 mm, smooth 0.2–0.4 mm, loose 0.35–0.8 mm. If the design has a `clearance` parameter, the UI offers a one-click fix.

## Known limitations / next steps

- `text()` doesn't work because the WASM build ships no fonts.
- Measurements from photos are estimates (±0.5–1 mm). The UI shows the model's confidence for each measurement. For tight fits, measure with calipers and enter the values in "Known measurements".
- Ideas: a printable "fit test" slice of the critical feature, print-readiness checks (thin walls, overhangs), tolerance presets per material, version history and undo, and exporting to a slicer.
