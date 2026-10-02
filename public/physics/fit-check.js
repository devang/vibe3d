// Two-body fit & physics check. Pure ES module so it runs in a browser Web Worker
// (see public/physics-worker.js) and in Node for testing.
//
// 1. Geometry (manifold-3d): find the socket in Part 1, line Part 2 (the shaft / pin / stem)
//    up with it, and measure real clearance or interference, insertion depth and the
//    rotational orientation of D-flats/keys.
// 2. Dynamics (MuJoCo WASM): MuJoCo collides each mesh as its convex hull, which would fill
//    in holes. So Part 1 is cut into wedge-shaped pieces around the socket axis (each nearly
//    convex) and Part 2 into thin horizontal slabs. Then we seat the part, wiggle it, twist
//    it and push it, and measure what actually happens.
//
// All geometry is in millimetres; MuJoCo runs in metres (scale 0.001).

const EPS_VOL = 0.02; // mm³ of overlap treated as "touching", not interference
const PLA_DENSITY = 1240; // kg/m³

const FIT_TARGETS = {
  // Per-side radial clearance in the *designed* geometry (mm). FDM printers print holes slightly
  // undersize, so a designed 0.1-0.2 mm gap usually ends up as a firm fit.
  snug: { min: -0.05, max: 0.25, label: "Snug / press fit", ideal: 0.15 },
  smooth: { min: 0.2, max: 0.4, label: "Smooth sliding / turning fit", ideal: 0.3 },
  loose: { min: 0.35, max: 0.8, label: "Loose / drop-in fit", ideal: 0.5 },
};

// ---------------------------------------------------------------------------
// STL <-> Manifold helpers
// ---------------------------------------------------------------------------

export function parseStl(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  if (n > 0 && 84 + n * 50 === bytes.byteLength) {
    const pos = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
    return pos;
  }
  // ASCII fallback
  const text = new TextDecoder().decode(bytes);
  const nums = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [+m[1], +m[2], +m[3]]);
  return new Float32Array(nums);
}

function manifoldFromStl(mf, buf) {
  const pos = parseStl(buf);
  const map = new Map();
  const verts = [];
  const tris = new Uint32Array(pos.length / 3);
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length / 3;
      map.set(key, idx);
      verts.push(x, y, z);
    }
    tris[i] = idx;
  }
  const mesh = new mf.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: tris });
  mesh.merge();
  return new mf.Manifold(mesh);
}

function manifoldToStl(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const nt = tv.length / 3;
  const out = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(out);
  dv.setUint32(80, nt, true);
  for (let t = 0; t < nt; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 3; k++) {
      const v = tv[t * 3 + k] * np;
      dv.setFloat32(o + k * 12, vp[v], true);
      dv.setFloat32(o + k * 12 + 4, vp[v + 1], true);
      dv.setFloat32(o + k * 12 + 8, vp[v + 2], true);
    }
  }
  return new Uint8Array(out);
}

function massProps(m) {
  // Volume-weighted centroid via signed tetrahedra.
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  let V = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < tv.length; t += 3) {
    const a = tv[t] * np, b = tv[t + 1] * np, c = tv[t + 2] * np;
    const ax = vp[a], ay = vp[a + 1], az = vp[a + 2];
    const bx = vp[b], by = vp[b + 1], bz = vp[b + 2];
    const qx = vp[c], qy = vp[c + 1], qz = vp[c + 2];
    const v = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
    V += v;
    cx += v * (ax + bx + qx) / 4;
    cy += v * (ay + by + qy) / 4;
    cz += v * (az + bz + qz) / 4;
  }
  return { volume: V, centroid: V ? [cx / V, cy / V, cz / V] : [0, 0, 0] };
}

const bbox = (m) => {
  const b = m.boundingBox();
  return { min: [...b.min], max: [...b.max] };
};

function overlapVolume(a, b) {
  const i = a.intersect(b);
  const v = i.isEmpty() ? 0 : i.volume();
  i.delete();
  return v;
}

// ---------------------------------------------------------------------------
// Part 2 (mating fixture)
// ---------------------------------------------------------------------------

/** Build a primitive fixture (shaft) when no Part 2 mesh is available. Top at z=0, axis at origin. */
function primitiveFixture(mf, spec, length) {
  const mp = spec.mating_part || {};
  const d = Math.max(0.5, mp.primary_dim_mm || 6);
  const r = d / 2;
  const { CrossSection } = mf;
  let cs;
  switch (mp.type) {
    case "d_shaft": {
      const flat = mp.flat_mm && mp.flat_mm < d ? mp.flat_mm : d * 0.77;
      cs = CrossSection.circle(r, 96).intersect(CrossSection.square([d + 2, flat]).translate([-(d + 2) / 2, -r]));
      break;
    }
    case "slot":
      cs = CrossSection.square([d, Math.max(1, d * 0.35)], true);
      break;
    default:
      cs = CrossSection.circle(r, 96);
  }
  const m = cs.extrude(length).translate([0, 0, -length]);
  cs.delete();
  return m;
}

/**
 * Normalise Part 2 so its mating end (top) sits at z=0 and the axis of its top section is at x=y=0.
 * Returns { fixture, crossDim } where crossDim is the largest width of the tip (used to convert
 * scale factors into mm).
 */
function normaliseFixture(mf, m) {
  const b = bbox(m);
  const top = b.max[2];
  // The tip's axis is the centre of the smallest circle around its cross-section. That works for
  // round, D-shaped (flat cuts less than half the circle) and rectangular profiles alike.
  const cs = m.slice(top - Math.min(0.75, (top - b.min[2]) / 2));
  const pts = cs.toPolygons().flat();
  cs.delete();
  const [cx, cy, r] = pts.length ? minEnclosingCircle(pts) : [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0];
  return { fixture: m.translate([-cx, -cy, -top]), crossDim: r ? 2 * r : Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) };
}

/** Smallest enclosing circle (Welzl, iterative). Returns [cx, cy, r]. */
export function minEnclosingCircle(points) {
  const P = points.map((p) => [p[0], p[1]]);
  for (let i = P.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [P[i], P[j]] = [P[j], P[i]];
  }
  const inC = (c, p) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= c[2] + 1e-7;
  const two = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.hypot(a[0] - b[0], a[1] - b[1]) / 2];
  const three = (a, b, c) => {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
    const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
    return [ux, uy, Math.hypot(a[0] - ux, a[1] - uy)];
  };
  let c = [P[0][0], P[0][1], 0];
  for (let i = 1; i < P.length; i++) {
    if (inC(c, P[i])) continue;
    c = [P[i][0], P[i][1], 0];
    for (let j = 0; j < i; j++) {
      if (inC(c, P[j])) continue;
      c = two(P[i], P[j]);
      for (let k = 0; k < j; k++) {
        if (inC(c, P[k])) continue;
        c = three(P[i], P[j], P[k]) || c;
      }
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Part 1 socket search
// ---------------------------------------------------------------------------

/** Move Part 1 so the socket opening faces down (−z), its axis is at x=y=0 and the part sits on z=0. */
function findSocket(mf, part, probeR) {
  const candidates = [];
  for (const flip of [false, true]) {
    const p0 = flip ? part.rotate([180, 0, 0]) : part.translate([0, 0, 0]);
    const b0 = bbox(p0);
    const p = p0.translate([0, 0, -b0.min[2]]);
    p0.delete();
    const b = bbox(p);
    const H = b.max[2];
    const centres = [
      [0, 0],
      [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2],
    ];
    for (const [cx, cy] of centres) {
      // Binary search the deepest a thin probe can go in from below without touching.
      const probe = (h) => mf.Manifold.cylinder(h + 2, probeR, probeR, 32).translate([cx, cy, -2]);
      const ok = (h) => {
        const pr = probe(h);
        const v = overlapVolume(p, pr);
        pr.delete();
        return v < EPS_VOL;
      };
      if (!ok(0.3)) {
        candidates.push({ flip, cx, cy, depth: 0, H });
        continue;
      }
      let lo = 0.3, hi = H + 1;
      if (ok(hi)) lo = hi;
      else for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (ok(mid)) lo = mid;
        else hi = mid;
      }
      candidates.push({ flip, cx, cy, depth: lo, H });
    }
    candidates.forEach((c) => c.flip === flip && (c.part = c.part || p));
  }
  candidates.sort((a, b) => b.depth - a.depth);
  const best = candidates[0];
  const canonical = best.part.translate([-best.cx, -best.cy, 0]);
  for (const c of new Set(candidates.map((c) => c.part))) c.delete();
  const through = best.depth >= best.H + 0.5;
  return { part: canonical, depth: Math.min(best.depth, best.H), through, flipped: best.flip, H: best.H };
}

// ---------------------------------------------------------------------------
// Geometry fit analysis
// ---------------------------------------------------------------------------

function analyseFit(mf, part, fixture, crossDim, socket, spec, log) {
  const keyed = ["d_shaft", "slot"].includes(spec.mating_part?.type);
  // For a blind socket, stop the measuring prism well short of the bottom so the gap we measure
  // is the radial one, not the gap to the end of the hole.
  const engage = socket.through ? socket.H : socket.depth > 4 ? socket.depth - 2.1 : socket.depth * 0.5;
  const gapLimit = socket.through || socket.depth > 4 ? 2 : Math.max(0.05, socket.depth * 0.5 - 0.01);
  // 2D profile of Part 2's mating section, a little below its tip, extruded through the socket.
  // Offsetting this profile gives an exact uniform grow/shrink for measuring interference.
  const fb = bbox(fixture);
  const sliceZ = -Math.min(Math.max(0.3, engage / 2), 3, -fb.min[2] / 2);
  const profile = fixture.slice(sliceZ);
  const prisms = new Map();
  const prism = (delta) => {
    if (!prisms.has(delta)) {
      const cs = delta ? profile.offset(delta, "Round", 2, 64) : profile;
      prisms.set(delta, cs.isEmpty() ? null : cs.extrude(engage + 2).translate([0, 0, -2]));
      if (delta) cs.delete();
    }
    return prisms.get(delta);
  };
  const place = (delta, angle, o) => {
    const pr = prism(delta);
    return pr ? pr.rotate([0, 0, angle]).translate([o[0], o[1], 0]) : null;
  };
  // Higher is better: the gap when clear, minus the overlap volume when colliding.
  const score = (delta, a, o) => {
    const f = place(delta, a, o);
    if (!f) return -Infinity;
    const v = overlapVolume(part, f);
    const sc = v > EPS_VOL ? -v : part.minGap(f, gapLimit);
    f.delete();
    return sc;
  };

  const findPose = (delta) => {
    let best = { angle: 0, off: [0, 0], score: score(delta, 0, [0, 0]) };
    const tryAngles = (list) => {
      for (const a of list) {
        const sc = score(delta, a, best.off);
        if (sc > best.score) best = { ...best, angle: a, score: sc };
      }
    };
    const centre = (span, step) => {
      const base = best.off;
      for (let dx = -span; dx <= span + 1e-9; dx += step)
        for (let dy = -span; dy <= span + 1e-9; dy += step) {
          const o = [base[0] + dx, base[1] + dy];
          const sc = score(delta, best.angle, o);
          if (sc > best.score) best = { ...best, off: o, score: sc };
        }
    };
    if (keyed || crossDim > 0) tryAngles(Array.from({ length: 71 }, (_, i) => (i + 1) * 5));
    centre(Math.min(1.2, crossDim * 0.2), Math.min(0.3, crossDim * 0.05));
    tryAngles([-4, -3, -2, -1, 1, 2, 3, 4].map((d) => best.angle + d));
    centre(0.15, 0.05);
    return best;
  };

  // 1. Find a pose (rotation + centring) where Part 2 is clear of Part 1, shrinking it if needed.
  let pose = null, shrink = 0;
  for (const delta of [0, -0.1, -0.25, -0.5, -1, -crossDim * 0.3]) {
    const p = findPose(delta);
    log?.(`pose @δ=${delta}: ${p.angle}°, (${p.off.map((v) => v.toFixed(2))}), score ${p.score.toFixed(3)}`);
    if (p.score >= 0) {
      pose = p;
      shrink = delta;
      break;
    }
  }

  // 2. Clearance (positive, exact via minGap) or interference (negative, via binary search on the offset).
  let clearance;
  if (!pose) {
    pose = { angle: 0, off: [0, 0] };
    clearance = -crossDim / 2;
  } else if (shrink === 0) {
    clearance = pose.score;
  } else {
    let lo = shrink, hi = 0;
    for (let i = 0; i < 14; i++) {
      const mid = Math.round(((lo + hi) / 2) * 1e4) / 1e4;
      if (score(mid, pose.angle, pose.off) >= 0) lo = mid;
      else hi = mid;
    }
    clearance = lo;
  }
  for (const pr of prisms.values()) pr?.delete();
  profile.delete();
  return { angle: pose.angle, offset: pose.off, clearance, engage };
}

// ---------------------------------------------------------------------------
// Convex decomposition for MuJoCo
// ---------------------------------------------------------------------------

function components(m) {
  const parts = m.decompose();
  m.delete();
  return parts;
}

/** Cut Part 1 into wedges around the z axis below `cutZ` (the socket), plus whatever is above. */
function wedgePieces(mf, part, cutZ, wedges = 24) {
  const b = bbox(part);
  const R = Math.max(...b.max.map(Math.abs), ...b.min.map(Math.abs)) * 2 + 10;
  const pieces = [];
  const below = part.trimByPlane([0, 0, -1], -cutZ);
  const above = part.trimByPlane([0, 0, 1], cutZ);
  for (let k = 0; k < wedges; k++) {
    const a0 = (2 * Math.PI * k) / wedges, a1 = (2 * Math.PI * (k + 1)) / wedges;
    const tri = new mf.CrossSection([[[0, 0], [R * Math.cos(a0), R * Math.sin(a0)], [R * Math.cos(a1), R * Math.sin(a1)]]]);
    const prism = tri.extrude(cutZ + 2).translate([0, 0, -1]);
    tri.delete();
    pieces.push(...components(below.intersect(prism)));
    prism.delete();
  }
  below.delete();
  if (!above.isEmpty()) pieces.push(...components(above));
  else above.delete();
  return pieces.filter((p) => {
    const keep = !p.isEmpty() && p.volume() > 0.3;
    if (!keep) p.delete();
    return keep;
  });
}

/** Cut a mesh into horizontal slabs (each slab of a shaft/stem is close to convex). */
function slabPieces(mf, m, slab = 1.5) {
  const b = bbox(m);
  const pieces = [];
  for (let z = b.min[2]; z < b.max[2] - 1e-6; z += slab) {
    const s = m.trimByPlane([0, 0, 1], z).trimByPlane([0, 0, -1], -(z + slab));
    pieces.push(...components(s));
  }
  return pieces.filter((p) => {
    const keep = !p.isEmpty() && p.volume() > 0.05;
    if (!keep) p.delete();
    return keep;
  });
}

// ---------------------------------------------------------------------------
// MuJoCo simulation
// ---------------------------------------------------------------------------

const quatTiltDeg = (q) => {
  // angle between body z axis and world z axis
  const [, x, y] = q;
  const zz = 1 - 2 * (x * x + y * y);
  return (Math.acos(Math.max(-1, Math.min(1, zz))) * 180) / Math.PI;
};
const quatYawDeg = (q) => {
  const [w, x, y, z] = q;
  return (Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180) / Math.PI;
};

function simulate(mj, mf, { partPieces, fixturePieces, part, motion, startZ, floorZ: floorOverride, log }) {
  const dir = "/sim" + Math.random().toString(36).slice(2, 8);
  mj.FS.mkdir(dir);
  const assets = [];
  const partGeoms = [];
  const fixtureGeoms = [];
  partPieces.forEach((p, i) => {
    mj.FS.writeFile(`${dir}/p${i}.stl`, manifoldToStl(p));
    assets.push(`<mesh name="p${i}" file="p${i}.stl" scale="0.001 0.001 0.001"/>`);
    partGeoms.push(`<geom type="mesh" mesh="p${i}" rgba="0.95 0.7 0.2 1" friction="0.35 0.005 0.0001"/>`);
  });
  fixturePieces.forEach((p, i) => {
    mj.FS.writeFile(`${dir}/f${i}.stl`, manifoldToStl(p));
    assets.push(`<mesh name="f${i}" file="f${i}.stl" scale="0.001 0.001 0.001"/>`);
    fixtureGeoms.push(`<geom type="mesh" mesh="f${i}" rgba="0.3 0.5 0.9 1" friction="0.35 0.005 0.0001"/>`);
  });

  const { volume, centroid } = massProps(part);
  const b = bbox(part);
  const mass = Math.max(1e-4, volume * 1e-9 * PLA_DENSITY); // kg
  const dims = [0, 1, 2].map((k) => (b.max[k] - b.min[k]) * 1e-3);
  const inertia = [
    (mass * (dims[1] ** 2 + dims[2] ** 2)) / 12,
    (mass * (dims[0] ** 2 + dims[2] ** 2)) / 12,
    (mass * (dims[0] ** 2 + dims[1] ** 2)) / 12,
  ];
  const floorZ = floorOverride ?? (fixturePieces.length ? Math.min(...fixturePieces.map((p) => bbox(p).min[2])) : 0);

  const xml = `<mujoco model="fit_check">
  <compiler meshdir="${dir}" boundmass="1e-6" boundinertia="1e-12"/>
  <option timestep="0.0002" gravity="0 0 -9.81" cone="elliptic" impratio="5"/>
  <default><geom solref="0.002 1" solimp="0.95 0.99 0.0002" margin="0"/></default>
  <asset>${assets.join("")}</asset>
  <worldbody>
    <geom type="plane" size="1 1 0.01" pos="0 0 ${(floorZ * 1e-3).toFixed(6)}"/>
    <body name="fixture">${fixtureGeoms.join("")}</body>
    <body name="part" pos="0 0 ${(startZ * 1e-3).toFixed(6)}">
      <freejoint/>
      <inertial pos="${centroid.map((c) => (c * 1e-3).toFixed(6)).join(" ")}" mass="${mass.toExponential(4)}" diaginertia="${inertia.map((v) => v.toExponential(4)).join(" ")}"/>
      ${partGeoms.join("")}
    </body>
  </worldbody>
</mujoco>`;
  mj.FS.writeFile(`${dir}/scene.xml`, xml);

  let model, data;
  try {
    model = mj.MjModel.from_xml_path(`${dir}/scene.xml`);
  } catch (e) {
    throw new Error("MuJoCo could not load the model: " + (e?.message || e));
  }
  data = new mj.MjData(model);
  const partBody = model.nbody - 1;
  const g = 9.81;
  const weight = mass * g;
  const comHeight = centroid[2] * 1e-3;
  const topZ = b.max[2] * 1e-3;

  const pose = () => ({
    pos: [data.qpos[0], data.qpos[1], data.qpos[2]],
    quat: [data.qpos[3], data.qpos[4], data.qpos[5], data.qpos[6]],
  });
  const finite = () => Array.from({ length: 7 }, (_, i) => data.qpos[i]).every(Number.isFinite);
  const setForce = (f = [0, 0, 0], t = [0, 0, 0]) => {
    const o = partBody * 6;
    for (let i = 0; i < 3; i++) {
      data.xfrc_applied[o + i] = f[i];
      data.xfrc_applied[o + 3 + i] = t[i];
    }
  };
  const run = (seconds, each) => {
    const n = Math.round(seconds / model.opt.timestep);
    for (let i = 0; i < n; i++) {
      mj.mj_step(model, data);
      if (each && i % 10 === 0) each();
    }
  };

  const result = { stable: true };
  try {
    const z0 = data.qpos[2];
    // 1. Settle under gravity.
    run(motion === "sliding" ? 0.02 : 0.15);
    if (!finite()) throw new Error("unstable");

    if (motion === "sliding") {
      // Push it on along the axis with ~2 N and see how far it travels from where it started.
      setForce([0, 0, -2]);
      run(0.25);
      setForce();
      run(0.05);
      result.slideTravelMm = (z0 - data.qpos[2]) * 1e3;
    }

    const seated = pose();
    result.seatedZmm = seated.pos[2] * 1e3;

    // 2. Wiggle: sideways push at the top, both directions. Mated parts get a push of twice their
    // weight; free-standing parts get a gentle nudge (30% of their weight).
    const F = motion === "static" ? 0.3 * weight : 2 * weight;
    const lever = topZ - comHeight;
    let maxTilt = 0, maxShift = 0;
    for (const sgn of [1, -1]) {
      setForce([sgn * F, 0, 0], [0, sgn * F * lever, 0]);
      run(0.08, () => {
        const p = pose();
        maxTilt = Math.max(maxTilt, quatTiltDeg(p.quat));
        maxShift = Math.max(maxShift, Math.hypot(p.pos[0] - seated.pos[0], p.pos[1] - seated.pos[1]) * 1e3);
      });
    }
    setForce();
    run(0.05);
    result.wobbleTiltDeg = maxTilt;
    result.wobbleShiftMm = maxShift;

    // 3. Twist about the axis, about what fingers apply to a part this size. Stop as soon as it
    // has clearly turned so a free-spinning part doesn't wind up to a silly speed.
    if (motion === "rotating" && fixturePieces.length) {
      const radius = Math.max(...[b.min[0], b.max[0], b.min[1], b.max[1]].map(Math.abs)) * 1e-3;
      const T = Math.min(0.02, Math.max(0.002, 4 * weight * radius)); // N·m
      const yaw0 = quatYawDeg(pose().quat);
      let maxYaw = 0;
      setForce([0, 0, 0], [0, 0, T]);
      const n = Math.round(0.15 / model.opt.timestep);
      for (let i = 0; i < n && maxYaw < 90; i++) {
        mj.mj_step(model, data);
        if (i % 10 === 0) {
          let dy = quatYawDeg(pose().quat) - yaw0;
          dy = ((dy + 540) % 360) - 180;
          maxYaw = Math.max(maxYaw, Math.abs(dy));
        }
      }
      setForce();
      for (let i = 0; i < model.nv; i++) data.qvel[i] = 0;
      run(0.03);
      result.twistDeg = maxYaw;
      result.twistTorqueNm = T;
    }

    if (!finite()) throw new Error("unstable");
    const end = pose();
    const drift = Math.hypot(end.pos[0] - seated.pos[0], end.pos[1] - seated.pos[1], end.pos[2] - seated.pos[2]) * 1e3;
    if (drift > 5 || maxShift > 5) result.poppedOff = true;
    result.finalTiltDeg = quatTiltDeg(end.quat);
  } catch {
    result.stable = false;
  } finally {
    data.delete();
    model.delete();
    for (const f of mj.FS.readdir(dir)) if (f !== "." && f !== "..") mj.FS.unlink(`${dir}/${f}`);
    mj.FS.rmdir(dir);
  }
  log?.(`sim: ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {any} o.mj       loaded @mujoco/mujoco module
 * @param {any} o.mf       loaded manifold-3d module (after setup())
 * @param {ArrayBuffer|Uint8Array} o.part1Stl  the generated part
 * @param {ArrayBuffer|Uint8Array} [o.part2Stl] the mating part (shaft, stem, pin...) if available
 * @param {object} o.spec  PhysicsSpec { motion, fit_preference, mating_part }
 */
export function runFitCheck({ mj, mf, part1Stl, part2Stl, spec, log }) {
  const t0 = Date.now();
  const motion = spec?.motion || "static";
  const fitPref = spec?.fit_preference || "smooth";
  const mp = spec?.mating_part || { type: "flat_ground", primary_dim_mm: 0 };
  const target = FIT_TARGETS[fitPref] || FIT_TARGETS.smooth;
  const issues = [], notes = [], recommendations = [];
  const report = {
    passed: false,
    motion,
    fit_preference: fitPref,
    mating_part: mp,
    criteria: { min_clearance_mm: target.min, max_clearance_mm: target.max, description: target.label },
    notes,
    issues,
    recommendations,
  };
  const garbage = [];
  const keep = (m) => (garbage.push(m), m);

  try {
    let part1;
    try {
      part1 = keep(manifoldFromStl(mf, part1Stl));
    } catch {
      issues.push("The part's mesh isn't watertight, so it can't be simulated. Rebuild it and try again.");
      return report;
    }
    if (part1.isEmpty()) {
      issues.push("The part's mesh is empty.");
      return report;
    }

    const isStatic = motion === "static" || mp.type === "flat_ground" || !(mp.primary_dim_mm > 0);

    // ---- Static parts: does it sit flat and stay put? ----
    if (isStatic) {
      const b = bbox(part1);
      const p = keep(part1.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]));
      const sim = simulate(mj, mf, { partPieces: [p], fixturePieces: [], part: p, motion: "static", startZ: 0.5, log });
      // Geometric stability: how far it can lean before the centre of mass passes the edge of its footprint.
      const foot = p.slice(Math.min(0.1, (b.max[2] - b.min[2]) / 4)).hull();
      const { centroid } = massProps(p);
      const edgeDist = distanceToPolygonEdge(foot.toPolygons()[0] || [], [centroid[0], centroid[1]]);
      foot.delete();
      const tipDeg = (Math.atan2(Math.max(0, edgeDist), Math.max(1e-6, centroid[2])) * 180) / Math.PI;
      report.metrics = { simulation_stable: sim.stable, final_tilt_deg: round(sim.finalTiltDeg, 1), wobble_tilt_deg: round(sim.wobbleTiltDeg, 1), tip_angle_deg: round(tipDeg, 1) };
      if (!sim.stable) issues.push("The simulation became unstable. The part may be too thin or tiny to simulate reliably.");
      else if (tipDeg <= 0) issues.push("Its centre of mass is outside its base, so it falls over when set down. Widen or move the base.");
      else if (sim.finalTiltDeg > 2) issues.push(`It doesn't sit flat: it settles at a ${sim.finalTiltDeg.toFixed(0)}° tilt on a flat surface.`);
      else notes.push("Sits flat on a level surface.");
      if (sim.stable && tipDeg > 0 && (sim.wobbleTiltDeg > 25 || tipDeg < 8))
        issues.push(`It tips over easily: it only needs to lean ${tipDeg.toFixed(0)}° before falling. Consider a wider base or a lower centre of mass.`);
      else if (sim.stable) notes.push(`Stable: it would have to lean ${tipDeg.toFixed(0)}° before tipping over.`);
      report.passed = issues.length === 0;
      return report;
    }

    // ---- Mating parts ----
    const d = mp.primary_dim_mm;
    const socket = findSocket(mf, part1, Math.max(0.3, d * 0.22));
    const p1 = keep(socket.part);
    log?.(`socket depth ${socket.depth.toFixed(2)} mm, through=${socket.through}, flipped=${socket.flipped}`);

    let fixtureRaw, fixtureSource;
    if (part2Stl) {
      try {
        fixtureRaw = keep(manifoldFromStl(mf, part2Stl));
        fixtureSource = "mesh";
      } catch {
        notes.push("The mating part's model wasn't usable, so a standard shaft was used instead.");
      }
    }
    let fixture, crossDim;
    if (fixtureRaw) {
      ({ fixture, crossDim } = normaliseFixture(mf, fixtureRaw));
    } else {
      fixture = primitiveFixture(mf, spec, (mp.depth_mm || 15) + 10);
      crossDim = d;
      fixtureSource = "primitive";
    }
    keep(fixture);

    report.metrics = { socket_depth_mm: round(socket.depth, 2), through_hole: socket.through, fixture: fixtureSource };

    if (socket.depth < Math.min(2, (mp.depth_mm || 10) * 0.25)) {
      issues.push(
        `Couldn't find a hole or socket for a ${d} mm ${label(mp.type)} on the part's main axis. Make sure the mating hole is centred and opens on the top or bottom face.`,
      );
      return report;
    }

    const fit = analyseFit(mf, p1, fixture, crossDim, socket, spec, log);
    const c = fit.clearance;
    report.metrics.clearance_per_side_mm = round(c, 3);
    report.metrics.engagement_mm = round(socket.through ? socket.H : Math.min(socket.depth, mp.depth_mm || socket.depth), 2);
    report.metrics.orientation_deg = fit.angle;

    const wanted = mp.depth_mm || 0;
    if (!socket.through && wanted && socket.depth + 0.3 < wanted * 0.8) {
      notes.push(`The socket is ${socket.depth.toFixed(1)} mm deep but the ${label(mp.type)} goes in about ${wanted} mm, so it will bottom out early.`);
    }

    // Geometry verdict
    if (c < -0.3) {
      issues.push(`Won't fit: the ${label(mp.type)} is about ${(-c).toFixed(2)} mm per side too big for the hole.`);
    } else if (c < target.min) {
      issues.push(`Too tight for a ${fitPref} fit: about ${(-c).toFixed(2)} mm of interference per side. It may crack or not go on.`);
    } else if (c > target.max) {
      issues.push(`Too loose for a ${fitPref} fit: ${c.toFixed(2)} mm of clearance per side (target ${target.min}–${target.max} mm).`);
    } else {
      notes.push(`Clearance ${c >= 0 ? c.toFixed(2) + " mm per side" : (-c).toFixed(2) + " mm interference per side"}, inside the ${fitPref} range (${target.min}–${target.max} mm).`);
    }
    report.metrics.clearance_change_needed_mm = c < target.min || c > target.max ? round(target.ideal - c, 2) : 0;

    // ---- Dynamics (skip if they overlap a lot: MuJoCo would just shove them apart) ----
    if (c > -0.05) {
      const partPieces = wedgePieces(mf, p1, socket.through ? socket.H + 1 : Math.max(0.5, socket.depth - 0.1)).map(keep);
      const seatTop = socket.through ? socket.H + 0.35 : socket.depth - 0.05;
      const fx = keep(fixture.rotate([0, 0, fit.angle]).translate([fit.offset[0], fit.offset[1], seatTop]));
      const fixturePieces = slabPieces(mf, fx).map(keep);
      const startZ = motion === "sliding" ? Math.min(socket.depth * 0.5, 6) + 0.5 : 0.5;
      const sim = simulate(mj, mf, { partPieces, fixturePieces, part: p1, motion, startZ, floorZ: socket.through ? 0 : undefined, log });
      Object.assign(report.metrics, {
        simulation_stable: sim.stable,
        popped_off: !!sim.poppedOff,
        wobble_tilt_deg: round(sim.wobbleTiltDeg, 2),
        wobble_shift_mm: round(sim.wobbleShiftMm, 3),
        twist_deg: sim.twistDeg != null ? round(sim.twistDeg, 1) : undefined,
        slide_travel_mm: sim.slideTravelMm != null ? round(sim.slideTravelMm, 2) : undefined,
        pieces: partPieces.length + fixturePieces.length,
      });
      if (!sim.stable) {
        issues.push("The MuJoCo simulation became unstable, so the dynamic checks couldn't be completed.");
      } else if (sim.poppedOff) {
        issues.push(`It comes off the ${label(mp.type)} with a light sideways push. Make the socket deeper or the fit snugger.`);
      } else {
        notes.push(`Wobble under a light sideways push: ${sim.wobbleTiltDeg.toFixed(1)}° tilt, ${sim.wobbleShiftMm.toFixed(2)} mm shift.`);
        if (fitPref === "snug" && sim.wobbleTiltDeg > 3) issues.push(`Wobbles ${sim.wobbleTiltDeg.toFixed(1)}° on the ${label(mp.type)}. Too much play for a snug fit.`);
        if (sim.twistDeg != null) {
          const keyed = ["d_shaft", "slot"].includes(mp.type);
          if (keyed && sim.twistDeg > 20) issues.push(`The flat/key doesn't grip: the part spun ${sim.twistDeg.toFixed(0)}° on the ${label(mp.type)} when twisted.`);
          else if (keyed) notes.push(`The flat/key engages: only ${sim.twistDeg.toFixed(1)}° of backlash when twisted.`);
          else if (fitPref !== "snug" && sim.twistDeg < 3) issues.push("It barely turns when twisted. Too much friction for a part that should spin.");
          else if (!keyed) notes.push(`Turns ${sim.twistDeg.toFixed(0)}° under a light twist.`);
        }
        if (sim.slideTravelMm != null) {
          const expect = Math.min(socket.depth * 0.5, 6) + 0.15;
          if (sim.slideTravelMm < expect * 0.6) issues.push(`Jams when pushed on: it only slid ${sim.slideTravelMm.toFixed(1)} of ~${expect.toFixed(1)} mm.`);
          else notes.push(`Slides on smoothly (${sim.slideTravelMm.toFixed(1)} mm travel under a 2 N push).`);
        }
      }
    } else {
      notes.push("Skipped the motion simulation because the parts overlap. Fix the fit first.");
    }

    if (report.metrics.clearance_change_needed_mm) {
      const delta = report.metrics.clearance_change_needed_mm;
      recommendations.push(`${delta > 0 ? "Increase" : "Decrease"} the hole clearance by about ${Math.abs(delta).toFixed(2)} mm per side.`);
    }
    notes.push("FDM printers usually print holes 0.1–0.2 mm undersize. Print a quick test piece if the fit is critical.");
    report.passed = issues.length === 0;
    return report;
  } catch (e) {
    issues.push("Physics check failed: " + (e?.message || String(e)));
    return report;
  } finally {
    report.metrics = { ...(report.metrics || {}), runtime_ms: Date.now() - t0 };
    for (const m of garbage) {
      try {
        m.delete();
      } catch {}
    }
  }
}

/** Signed distance from point to the nearest edge of a convex polygon (positive when inside). */
function distanceToPolygonEdge(poly, p) {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area >= 0 ? 1 : -1;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    best = Math.min(best, (sgn * (ex * (p[1] - a[1]) - ey * (p[0] - a[0]))) / len);
  }
  return best;
}

function label(type) {
  return { d_shaft: "D-shaft", round_shaft: "shaft", pin: "pin", slot: "key/tab", flat_ground: "surface" }[type] || "mating part";
}
const round = (v, n) => (v == null || !Number.isFinite(v) ? v : Math.round(v * 10 ** n) / 10 ** n);
