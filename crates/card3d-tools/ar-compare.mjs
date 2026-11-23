// The AR export's comparison: each design's GLB and USDZ from the
// three.js engine (the local archive's packages/core/src/ar/, Chrome: three-archive.mjs) and from the
// Rust engine (`card3d_engine::ar`: natively, and --web / --webgl in Chrome), compared on structure
// (nodes, meshes, materials, files, zip alignment), geometry (counts, bounds, order-free sums) and the
// baked textures (sizes, mean error per channel). Without the archive (.archive/three-engine/) the web
// builds' files are compared with the native ones instead. Run from the repository root after
// crates/card3d-web/build-web.sh:
//
//   node crates/card3d-tools/ar-compare.mjs [--web] [--webgl] [--only <name,...>] [--keep]
//
// Files go to crates/card3d-tools/out-ar/<design>/{three,rust,webgpu,webgl}.{glb,usdz}, deleted after
// the comparison unless --keep. Exits 1 when a file breaks its format's invariants or the geometry
// differs; texture differences over 0.5 / 255 (mean, per channel) are reported.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { launchWebChrome } from "./web-chrome.mjs";
import { hasThreeArchive, linkArchiveModules, threeArchive } from "./three-archive.mjs";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../..");
const OUT = resolve(HERE, "out-ar");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const DESIGNS = ["preset-clean-silver", "holo-front", "stickers", "glass-clear", "body-shape-window", "body-edge-anodized", "artwork-printed", "face-halftone"];
const only = flag("--only") ? args[args.indexOf("--only") + 1].split(",") : DESIGNS;
const BAR = 0.5;

// vite, playwright and three come from this package's dev dependencies (package.json).
const req = createRequire(resolve(HERE, "package.json"));
const load = (m) => import(pathToFileURL(req.resolve(m)).href);
const { createServer: createVite } = await load("vite");
const pw = await load("playwright");
const chromium = pw.chromium ?? pw.default.chromium;

mkdirSync(OUT, { recursive: true });
const designsDir = resolve(OUT, "designs");
execFileSync(process.execPath, [resolve(HERE, "designs/generate.ts"), designsDir], { stdio: "inherit" });
const file = (name) => resolve(designsDir, `${name}.json`);
for (const name of only) mkdirSync(resolve(OUT, name), { recursive: true });

// The reference: the three.js engine when the local archive is here, else the native files.
const THREE = hasThreeArchive();
const BASE = THREE ? "three" : "rust";
if (THREE) linkArchiveModules();
else console.log("No three.js archive (.archive/three-engine/): the web builds' files are compared with the native ones, not with three.js's.");

// ── three.js ────────────────────────────────────────────────────────────────
if (THREE) {
  const server = await createVite({
    configFile: false,
    root: resolve(HERE, "ref"),
    plugins: [threeArchive()],
    server: { port: 5298, fs: { allow: [ROOT] } },
    logLevel: "warn",
  });
  await server.listen();
  const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("three page error:", e.message));
    for (const name of only) {
      await page.goto(`${server.resolvedUrls.local[0]}ar.html?design=${encodeURIComponent(`/@fs${file(name)}`)}`);
      await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 120000 });
      const state = await page.evaluate(() => window.__ready);
      if (state !== true) throw new Error(`three ${name}: ${state}`);
      for (const f of ["glb", "usdz"]) writeFileSync(resolve(OUT, name, `three.${f}`), Buffer.from(await page.evaluate((f) => window.__ar(f), f), "base64"));
      console.log(`three: ${name}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

// ── the Rust engine: native ─────────────────────────────────────────────────
{
  const r = spawnSync("cargo", ["run", "-q", "--release", "-p", "card3d-tools", "--bin", "render", "--", "--ar", OUT, ...only.map(file)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ── the Rust engine in Chrome ───────────────────────────────────────────────
const builds = ["rust", ...(flag("--web") ? ["webgpu"] : []), ...(flag("--webgl") ? ["webgl"] : [])];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".woff2": "font/woff2", ".json": "application/json" };
if (builds.length > 1) {
  const server = createServer(async (q, s) => {
    let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = p.startsWith("/@abs/") ? p.slice(5) : resolve(ROOT, "." + p);
    let body;
    try {
      body = await readFile(f);
    } catch {
      return void s.writeHead(404).end();
    }
    s.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" }).end(body);
  }).listen(0);
  const browser = await launchWebChrome(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
    page.on("pageerror", (e) => console.log("engine page error:", e.message));
    for (const backend of builds.slice(1)) {
      for (const name of only) {
        await page.goto(
          `http://localhost:${server.address().port}/crates/card3d-web/web/?w=320&h=200&backend=${backend}&design=${encodeURIComponent(`/@abs${file(name)}`)}`,
        );
        await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 120000 });
        const state = await page.evaluate(() => window.__ready);
        if (state !== true) throw new Error(`${backend} ${name}: ${state}`);
        for (const f of ["glb", "usdz"])
          writeFileSync(resolve(OUT, name, `${backend}.${f}`), Buffer.from(await page.evaluate((f) => window.__ar(f), f), "base64"));
        console.log(`${backend}: ${name} (${await page.evaluate(() => window.__backend)})`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

// ── reading the files ───────────────────────────────────────────────────────
/** PNG (8-bit, RGB or RGBA, not interlaced) → { width, height, rgba }. */
function png(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let at = 8;
  let width = 0,
    height = 0,
    type = 0,
    depth = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const kind = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") [width, height, depth, type] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9]];
    if (kind === "IDAT") idat.push(data);
    if (kind === "IEND") break;
    at += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6)) throw new Error(`PNG type ${type} depth ${depth}`);
  const ch = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      px[y * stride + x] = (line[x] + [0, a, b, (a + b) >> 1, pr][f]) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) for (let k = 0; k < ch; k++) rgba[i * 4 + k] = px[i * ch + k];
  return { width, height, rgba };
}

function glb(buf) {
  const errors = [];
  if (buf.toString("latin1", 0, 4) !== "glTF") errors.push("magic");
  if (buf.readUInt32LE(4) !== 2) errors.push("version");
  if (buf.readUInt32LE(8) !== buf.length) errors.push("length");
  const jl = buf.readUInt32LE(12);
  if (buf.toString("latin1", 16, 20) !== "JSON" || jl % 4) errors.push("JSON chunk");
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jl));
  const bl = buf.readUInt32LE(20 + jl);
  if (buf.toString("latin1", 24 + jl, 28 + jl) !== "BIN\0" || bl % 4) errors.push("BIN chunk");
  const bin = buf.subarray(28 + jl, 28 + jl + bl);
  if (json.buffers?.[0]?.byteLength > bl) errors.push("buffer length");
  // The spec's invariants this model touches.
  for (const [i, v] of json.bufferViews.entries()) {
    if (v.byteOffset + v.byteLength > bl) errors.push(`bufferView ${i} out of range`);
    if (v.target === 34962 && (v.byteOffset % 4 || v.byteStride % 4 || v.byteStride < 4 || v.byteStride > 252)) errors.push(`bufferView ${i} alignment`);
  }
  for (const [i, a] of json.accessors.entries()) {
    const v = json.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    if (!v || a.componentType !== 5126 || !n) errors.push(`accessor ${i}`);
    else if ((a.byteOffset ?? 0) + (a.count - 1) * (v.byteStride ?? 4 * n) + 4 * n > v.byteLength) errors.push(`accessor ${i} out of range`);
  }
  for (const [i, m] of json.meshes.entries())
    for (const p of m.primitives) {
      const pos = json.accessors[p.attributes.POSITION];
      if (!pos?.min || !pos?.max) errors.push(`mesh ${i}: POSITION without min / max`);
      for (const [k, a] of Object.entries(p.attributes)) if (json.accessors[a].count !== pos.count) errors.push(`mesh ${i}: ${k} count`);
      if (p.material >= json.materials.length) errors.push(`mesh ${i}: material`);
    }
  for (const [i, t] of (json.textures ?? []).entries()) if (t.source >= json.images.length || t.sampler >= json.samplers.length) errors.push(`texture ${i}`);
  const nodes = json.nodes;
  const roots = json.scenes[json.scene].nodes;
  const seen = new Set();
  const walk = (i) => {
    if (seen.has(i)) errors.push(`node ${i} twice`);
    seen.add(i);
    for (const c of nodes[i].children ?? []) walk(c);
  };
  roots.forEach(walk);
  if (seen.size !== nodes.length) errors.push("nodes outside the scene");
  const read = (ai) => {
    const a = json.accessors[ai];
    const v = json.bufferViews[a.bufferView];
    const n = { VEC2: 2, VEC3: 3 }[a.type];
    const stride = v.byteStride ?? 4 * n;
    const out = [];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out.push(bin.readFloatLE(v.byteOffset + (a.byteOffset ?? 0) + k * stride + 4 * c));
    return { n, out, min: a.min, max: a.max };
  };
  const image = (ti) => {
    const im = json.images[json.textures[ti].source];
    const v = json.bufferViews[im.bufferView];
    return png(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength));
  };
  const meshes = {};
  for (const node of nodes) {
    if (node.mesh === undefined) continue;
    const p = json.meshes[node.mesh].primitives[0];
    const mat = json.materials[p.material];
    const pbr = mat.pbrMetallicRoughness ?? {};
    meshes[node.name] = {
      position: read(p.attributes.POSITION),
      normal: read(p.attributes.NORMAL),
      uv: p.attributes.TEXCOORD_0 !== undefined ? read(p.attributes.TEXCOORD_0) : null,
      material: {
        name: mat.name,
        factor: pbr.baseColorFactor ?? [1, 1, 1, 1],
        metallic: pbr.metallicFactor,
        roughness: pbr.roughnessFactor,
        alphaMode: mat.alphaMode ?? "OPAQUE",
      },
      maps: pbr.baseColorTexture
        ? { color: image(pbr.baseColorTexture.index), orm: image(pbr.metallicRoughnessTexture.index), normal: image(mat.normalTexture.index) }
        : null,
    };
  }
  const counts = {
    nodes: nodes.length,
    meshes: json.meshes.length,
    materials: json.materials.length,
    textures: json.textures?.length ?? 0,
    images: json.images?.length ?? 0,
  };
  return { json, errors, meshes, counts, matrix: nodes.find((n) => n.name === "card body")?.matrix };
}

function usdz(buf) {
  const errors = [];
  const files = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nl = buf.readUInt16LE(at + 26);
    const xl = buf.readUInt16LE(at + 28);
    const name = buf.toString("utf8", at + 30, at + 30 + nl);
    const data = at + 30 + nl + xl;
    if (method !== 0) errors.push(`${name} compressed`);
    if (data % 64) errors.push(`${name} at ${data} (not 64-byte aligned)`);
    files[name] = buf.subarray(data, data + size);
    at = data + size;
  }
  const names = Object.keys(files);
  if (names[0] !== "model.usda") errors.push("model.usda isn't first");
  const model = files["model.usda"]?.toString("utf8") ?? "";
  if (!/defaultPrim = "Root"/.test(model) || !/metersPerUnit = 1/.test(model) || !/upAxis = "Y"/.test(model)) errors.push("header");
  if (/token inputs:varname|token inputs:in\.connect|<\/Materials\//.test(model)) errors.push("not fixed (fixUsdz)");
  if (!/def "Materials"/.test(model.slice(0, model.lastIndexOf("}")))) errors.push("materials outside /Root");
  for (const m of model.matchAll(/@(\.\/)?([^@]+\.(usda|png))@/g)) if (!files[m[2]]) errors.push(`missing ${m[2]}`);
  // Per material, in order (edge, front, back): its textures' files.
  const materials = model
    .split(/def Material "/)
    .slice(1)
    .map((block) => {
      const tex = {};
      for (const m of block.matchAll(/def Shader "Texture_\w+?_(diffuse|normal|roughness|metallic)"[^}]*?asset inputs:file = @([^@]+)@[^}]*?\}/gs))
        tex[m[1]] = m[2];
      const normal = /def Shader "Texture_\w+_normal"[^}]*float4 inputs:scale = \(2, 2, 2, 1\)[^}]*float4 inputs:bias = \(-1, -1, -1, 0\)/s.test(block);
      return { tex, normal };
    });
  const geometry = names
    .filter((n) => n.startsWith("geometries/"))
    .map((n) => {
      const t = files[n].toString("utf8");
      const pts = (t.match(/point3f\[\] points = \[([^\]]*)\]/)?.[1].match(/\(([^)]*)\)/g) ?? []).map((p) => p.slice(1, -1).split(", ").map(Number));
      return { points: pts.length, sum: pts.reduce((s, p) => s + p[0] + 2 * p[1] + 3 * p[2], 0) };
    });
  const maps = materials
    .slice(1)
    .map((m) => (m.tex.diffuse ? { color: png(files[m.tex.diffuse]), orm: png(files[m.tex.roughness]), normal: png(files[m.tex.normal]) } : null));
  return {
    errors,
    counts: {
      files: names.length,
      geometries: geometry.length,
      textures: names.filter((n) => n.endsWith(".png")).length,
      materials: materials.length,
      xforms: (model.match(/def Xform/g) ?? []).length,
      normalScaleBias: materials.filter((m) => m.normal).length,
    },
    geometry,
    maps,
    anchoring: model.match(/planeAnchoring:alignment = "(\w+)"/)?.[1],
  };
}

/** Mean absolute error per channel (0–255) of two images, or null when their sizes differ. */
function imageError(a, b) {
  if (a.width !== b.width || a.height !== b.height) return null;
  let sum = 0;
  for (let i = 0; i < a.rgba.length; i += 4) for (let k = 0; k < 3; k++) sum += Math.abs(a.rgba[i + k] - b.rgba[i + k]);
  return sum / ((a.rgba.length / 4) * 3);
}

/** A triangle list's area and its distinct vertices (rounded to 1e-5, sorted): the same surface whatever its triangulation. */
function surface(pos) {
  let area = 0;
  const p = pos.out;
  for (let i = 0; i < p.length; i += 9) {
    const [ux, uy, uz] = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]];
    const [vx, vy, vz] = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  const set = new Set();
  for (let i = 0; i < p.length; i += 3) set.add([p[i], p[i + 1], p[i + 2]].map((v) => Math.round(v * 1e5)).join(","));
  return { area, vertices: [...set].sort().join(";") };
}

/** Order-free sums of a vertex attribute (x, y, z separately), and its bounds. */
const sums = (v) => {
  const s = Array.from({ length: v.n }, () => 0);
  for (let i = 0; i < v.out.length; i++) s[i % v.n] += v.out[i];
  return s;
};

// ── compare ─────────────────────────────────────────────────────────────────
let status = 0;
const report = [];
for (const name of only) {
  const three = { glb: glb(readFileSync(resolve(OUT, name, `${BASE}.glb`))), usdz: usdz(readFileSync(resolve(OUT, name, `${BASE}.usdz`))) };
  for (const b of builds.filter((x) => x !== BASE)) {
    const ours = { glb: glb(readFileSync(resolve(OUT, name, `${b}.glb`))), usdz: usdz(readFileSync(resolve(OUT, name, `${b}.usdz`))) };
    const notes = [...ours.glb.errors.map((e) => `GLB: ${e}`), ...ours.usdz.errors.map((e) => `USDZ: ${e}`)];
    const fails = notes.length > 0;
    const same = (what, x, y) => JSON.stringify(x) === JSON.stringify(y) || notes.push(`${what}: ${JSON.stringify(y)} (${BASE} ${JSON.stringify(x)})`);
    same("GLB counts", three.glb.counts, ours.glb.counts);
    same("USDZ counts", three.usdz.counts, ours.usdz.counts);
    same("anchoring", three.usdz.anchoring, ours.usdz.anchoring);
    const m3 = three.glb.matrix ?? [],
      m = ours.glb.matrix ?? [];
    if (m3.length !== 16 || m3.some((v, i) => Math.abs(v - m[i]) > 1e-9)) notes.push(`matrix ${JSON.stringify(m)} (${BASE} ${JSON.stringify(m3)})`);
    let geometryOff = false;
    for (const mesh of ["edge", "front face", "back face"]) {
      const [a, o] = [three.glb.meshes[mesh], ours.glb.meshes[mesh]];
      if (!a || !o) {
        notes.push(`${mesh} missing`);
        geometryOff = true;
        continue;
      }
      for (const attr of ["position", "normal", "uv"]) {
        if (Boolean(a[attr]) !== Boolean(o[attr])) notes.push(`${mesh} ${attr}: present ${!!o[attr]} (${BASE} ${!!a[attr]})`);
        if (!a[attr] || !o[attr]) continue;
        if (a[attr].out.length !== o[attr].out.length) {
          notes.push(`${mesh} ${attr}: ${o[attr].out.length / o[attr].n} vertices (${BASE} ${a[attr].out.length / a[attr].n})`);
          geometryOff = true;
          continue;
        }
        const d = Math.max(...sums(a[attr]).map((s, i) => Math.abs(s - sums(o[attr])[i]) / (a[attr].out.length / a[attr].n)));
        const box = Math.max(...a[attr].min.map((v, i) => Math.abs(v - o[attr].min[i])), ...a[attr].max.map((v, i) => Math.abs(v - o[attr].max[i])));
        if (box > 1e-5) {
          notes.push(`${mesh} ${attr}: bounds differ by ${box.toExponential(1)}`);
          geometryOff = true;
        } else if (d > 1e-5 && attr === "position") {
          // The same vertices and area, triangulated differently (a flat cap): noted, not a failure.
          const [sa, so] = [surface(a.position), surface(o.position)];
          const same = Math.abs(sa.area - so.area) < 1e-6 * sa.area && sa.vertices === so.vertices;
          notes.push(`${mesh}: ${same ? "the same surface (area, vertices), triangulated differently" : `positions differ (mean ${d.toExponential(1)})`}`);
          if (!same) geometryOff = true;
        } else if (d > 1e-5 && attr === "normal") {
          notes.push(`${mesh} normal: mean differs by ${d.toExponential(1)}`);
          geometryOff = true;
        }
      }
      const [ma, mo] = [a.material, o.material];
      const f = Math.max(...ma.factor.map((v, i) => Math.abs(v - mo.factor[i])), Math.abs(ma.metallic - mo.metallic), Math.abs(ma.roughness - mo.roughness));
      if (f > 1e-4 || ma.alphaMode !== mo.alphaMode || ma.name !== mo.name)
        notes.push(`${mesh} material ${JSON.stringify(mo)} (${BASE} ${JSON.stringify(ma)})`);
    }
    for (const [k, g] of ours.usdz.geometry.entries()) {
      const t = three.usdz.geometry[k];
      if (!t || t.points !== g.points) notes.push(`USDZ geometry ${k}: ${g.points} points (${BASE} ${t?.points})`);
    }
    // Textures: the GLB's (USDZ's are the same pixels: checked against the GLB's).
    const errs = [];
    for (const [side, mesh] of [
      ["front", "front face"],
      ["back", "back face"],
    ]) {
      for (const map of ["color", "orm", "normal"]) {
        const a = three.glb.meshes[mesh]?.maps?.[map];
        const o = ours.glb.meshes[mesh]?.maps?.[map];
        if (!a || !o) continue;
        const e = imageError(a, o);
        if (e === null) notes.push(`${side} ${map}: ${o.width}×${o.height} (${BASE} ${a.width}×${a.height})`);
        else errs.push(`${side} ${map} ${e.toFixed(2)}`);
        if (e !== null && e > BAR) notes.push(`${side} ${map}: mean error ${e.toFixed(2)}`);
        const u = ours.usdz.maps[side === "front" ? 0 : 1]?.[map];
        if (u && o && imageError(u, o) !== 0) notes.push(`USDZ ${side} ${map} differs from the GLB's`);
      }
    }
    if (fails || geometryOff) status = 1;
    report.push(`${name.padEnd(22)} ${b.padEnd(7)} ${errs.join(", ")}${notes.length ? `\n    ${notes.join("\n    ")}` : ""}`);
  }
}
console.log(`\n── AR models vs ${THREE ? "three.js" : "the native files"} (texture mean error per channel, 0–255) ──\n${report.join("\n")}`);
if (!flag("--keep")) for (const name of only) rmSync(resolve(OUT, name), { recursive: true, force: true });
process.exit(status);
