// OpenSCAD compile worker. Runs the WASM build entirely in the browser.
// Message in:  { id, code, defines?: { [name]: number|boolean } }
// Message out: { id, ok: true, stl: ArrayBuffer, log } | { id, ok: false, error, log }
import { createOpenSCAD } from "/vendor/openscad.js";

function formatDefine(name, value) {
  if (typeof value === "boolean") return `${name}=${value ? "true" : "false"}`;
  return `${name}=${Number(value)}`;
}

self.onmessage = async (e) => {
  const { id, code, defines = {} } = e.data;
  const log = [];
  try {
    // A fresh instance per compile: Emscripten's main() is not re-entrant.
    const openscad = await createOpenSCAD({
      noInitialRun: true,
      print: (t) => log.push(t),
      printErr: (t) => log.push(t),
    });
    const inst = openscad.getInstance();
    inst.FS.writeFile("/input.scad", code);

    const args = ["/input.scad", "--backend=manifold", "--export-format=binstl", "-o", "/output.stl"];
    for (const [k, v] of Object.entries(defines)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) args.push("-D", formatDefine(k, v));
    }

    let rc;
    try {
      rc = inst.callMain(args);
    } catch (err) {
      log.push(String(err?.message ?? err));
      rc = 1;
    }

    const text = log.filter((l) => !/Could not initialize localization/.test(l)).join("\n");
    let stl = null;
    try {
      stl = inst.FS.readFile("/output.stl");
    } catch {}

    if (rc !== 0 || !stl || stl.length < 84) {
      const hasErr = /ERROR|error/.test(text);
      const msg = hasErr ? text : text + "\nNo geometry was produced (the top-level object may be empty).";
      self.postMessage({ id, ok: false, error: msg.trim(), log: text });
      return;
    }
    const buf = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
    self.postMessage({ id, ok: true, stl: buf, log: text }, [buf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err), log: log.join("\n") });
  }
};
