// The Rust engine's comparison harness: every design in designs/ and every
// public preset is rendered by the Rust engine (native) and by the three.js engine (Chrome, the
// parity setup), then compared. Designs using features the Rust engine does not draw yet are listed
// as pending, with the features.
//
// The three.js engine is the local archive's (.archive/three-engine/, gitignored: three-archive.mjs).
// Without it (a fresh clone) there is no three.js reference: the run compares the web builds (--web,
// --webgl) with the native render instead, a cross-backend consistency check, and says so. Run from
// the repository root:
//
//   node crates/card3d-tools/compare.mjs [--web] [--webgl] [--only <substring>] [--dump-env] [--marquee]
//
//   --web       also render the WebGPU build in Chrome and compare it (crates/card3d-web/build-web.sh first)
//   --webgl     also render the WebGL 2 build
//   --only s    designs whose name contains s (or any of several, comma-separated)
//   --dump-env  write three's PMREM atlas to out/ref-env-atlas.f16 for `cargo run --bin dump_env`, then stop
//   --marquee   the marquee instead (out-marquee/): many cards in one canvas, at frozen strip states, drawn
//               by the three.js marquee and the engine's (native, and --web / --webgl)
//
// Output in crates/card3d-tools/out/<design>/{three,rust,webgpu,webgl}-<pose>.png; diffs for poses over
// the bar. Exits 1 if any comparison is over the bar.
//
// Environment: CARD3D_SWIFTSHADER=1 runs the web builds in headless Chromium on SwiftShader, no GPU needed
// (web-chrome.mjs; CI's webgpu job); CARD3D_NO_ARCHIVE=1 ignores the three.js archive (a fresh clone's run).
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { launchWebChrome } from "./web-chrome.mjs";
import { hasThreeArchive, linkArchiveModules, threeArchive } from "./three-archive.mjs";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "../..");
// `--quality performance`: the phone tier (256 px surface maps, a 128 px environment), in out-performance/.
const QUALITY = process.argv.includes("--quality") ? process.argv[process.argv.indexOf("--quality") + 1] : "full";
// `--fit contain`: the card framed as `<metal-card>` frames it, in out-contain/.
const FIT = process.argv.includes("--fit") ? process.argv[process.argv.indexOf("--fit") + 1] : "studio";
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const MARQUEE = flag("--marquee");
const OUT = resolve(
  HERE,
  [MARQUEE ? "marquee" : "", QUALITY === "full" ? "" : QUALITY, FIT === "studio" ? "" : FIT]
    .filter(Boolean)
    .map((s) => `-${s}`)
    .join("")
    .replace(/^/, "out"),
);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const POSES = { front: [0, 0, 0], tilt: [-0.22, 0.38, 0.04], back: [0, Math.PI, 0], edge: [0.1, 1.25, 0] };
const [W, H] = [1200, 750];

// vite, playwright and three come from this package's dev dependencies (package.json).
const req = createRequire(resolve(HERE, "package.json"));
const load = (m) => import(pathToFileURL(req.resolve(m)).href);
const { createServer: createVite } = await load("vite");
const pw = await load("playwright");
const chromium = pw.chromium ?? pw.default.chromium;

// The reference: the three.js engine when the local archive is here, else the native render.
const THREE = hasThreeArchive();
const BASE = THREE ? "three" : "rust";
const BASE_NAME = THREE ? "three.js" : "the native render";
if (THREE) linkArchiveModules();
else
  console.log(
    "\nNo three.js archive (.archive/three-engine/): the web builds are compared with the native render (cross-backend\n" +
      "consistency), not with three.js. Known differences of both builds apply (known-differences.json).",
  );

mkdirSync(OUT, { recursive: true });

// ── designs ──────────────────────────────────────────────────────────────────
execFileSync(process.execPath, [resolve(HERE, "designs/generate.ts"), resolve(OUT, "designs")], { stdio: "inherit" });
// Every design as `ensureDesign` returns it (generate.ts), so both engines get the same input.
const files = readdirSync(resolve(OUT, "designs"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => resolve(OUT, "designs", f))
  .filter((f) => !only || only.split(",").some((o) => basename(f).includes(o)));

// ── three.js engine (the reference) ─────────────────────────────────────────
async function withVite(fn) {
  const server = await createVite({
    configFile: false,
    root: resolve(HERE, "ref"),
    // `@three-engine/…`: the archived three.js engine (the ref pages' imports), run in place.
    plugins: [threeArchive()],
    server: { port: 5299, fs: { allow: [ROOT] } },
    logLevel: "warn",
  });
  await server.listen();
  const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
  try {
    return await fn(server.resolvedUrls.local[0], browser);
  } finally {
    await browser.close();
    await server.close();
  }
}

if (flag("--dump-env")) {
  if (!THREE) {
    console.error("--dump-env reads three.js's PMREM atlas: it needs the local three.js archive (.archive/three-engine/).");
    process.exit(1);
  }
  await withVite(async (url, browser) => {
    const page = await browser.newPage();
    await page.goto(`${url}?w=64&h=64`);
    await page.waitForFunction(() => window.__ready !== undefined);
    const [, b64] = (await page.evaluate((q) => window.__dumpEnv(q), QUALITY)).split(":");
    writeFileSync(resolve(OUT, "ref-env-atlas.f16"), Buffer.from(b64, "base64"));
    console.log(`three's PMREM atlas → ${OUT}/ref-env-atlas.f16`);
  });
  process.exit(0);
}

// ── the marquee ─────────────────────────────────────────────────────────────
if (MARQUEE) process.exit(await compareMarquee());

/**
 * The marquee in both engines (ref/marquee.ts): the same designs (frozen clocks, no shuffle) at a
 * fixed layout, each strip state (offset, marquee time) one comparison per canvas size.
 */
async function compareMarquee() {
  const ORDER = [
    "clean-silver",
    "amazing-coral",
    "gold-shine",
    "obsidian-aurora",
    "sunset-mesh",
    "liquid-mark",
    "brass-orbit-guilloche",
    "electric-blue",
    "thermal-skin",
    "lacquer-red",
    "silver-vines",
    "pearl-guilloche",
    "hero-black",
    "walnut",
  ];
  const names = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Hedy Lamarr", "Katherine Johnson", "Claude Shannon", "Emmy Noether"];
  const designs = ORDER.map((id, i) => ({
    ...JSON.parse(readFileSync(resolve(OUT, "designs", `preset-${id}.json`), "utf8")),
    cardholderName: names[i % names.length],
  }));
  const designsFile = resolve(OUT, "marquee-designs.json");
  writeFileSync(designsFile, JSON.stringify(designs));
  // One file per design too, in order, for the native renderer.
  const designFiles = designs.map((d, i) => {
    const f = resolve(OUT, "designs", `marquee-${String(i).padStart(2, "0")}.json`);
    writeFileSync(f, JSON.stringify(d));
    return f;
  });
  // Strip states: whole and fractional offsets (cards between slots, a face shader card at the centre),
  // a wrap past the design count, and two marquee times (the pitch wobble).
  const STATES = [
    [0, 0],
    [1.5, 1.3],
    [4.25, 2.6],
    [5, 0.7],
    [7.6, 3.9],
    [12.9, 5.2],
  ];
  const SIZES = [
    [1200, 750],
    [600, 760],
  ];
  const tag = ([o, t]) => `o${o}-t${t}`;
  const builds = ["rust", ...(flag("--web") ? ["webgpu"] : []), ...(flag("--webgl") ? ["webgl"] : [])];
  console.log(`\nRust marquee (native): ${STATES.length} states × ${SIZES.length} sizes`);
  for (const [w, h] of SIZES) {
    const states = STATES.map((st) => `${tag(st)}:${st[0]}:${st[1]}`).join(",");
    const r = spawnSync(
      "cargo",
      ["run", "-q", "--release", "-p", "card3d-tools", "--bin", "render", "--", "--marquee", OUT, `${w}x${h}`, states, ...designFiles],
      { cwd: ROOT, stdio: "inherit", env: { ...process.env, CARD3D_QUALITY: QUALITY } },
    );
    if (r.status !== 0) return r.status ?? 1;
  }
  const capture = async (url, browser, engine) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.log(`${engine} page error:`, e.message));
    page.on("response", (r) => r.status() >= 400 && !r.url().endsWith("/favicon.ico") && console.log(`${engine}: HTTP ${r.status()} ${r.url()}`));
    try {
      for (const [w, h] of SIZES) {
        const dir = resolve(OUT, `marquee-${w}x${h}`);
        mkdirSync(dir, { recursive: true });
        await page.goto(`${url}marquee.html?engine=${engine}&w=${w}&h=${h}&quality=${QUALITY}&designs=${encodeURIComponent(`/@fs${designsFile}`)}`);
        await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 120000 });
        const state = await page.evaluate(() => window.__ready);
        if (state !== true) throw new Error(`${engine} ${w}x${h}: ${state}`);
        for (const st of STATES) {
          const png = await page.evaluate(([o, t]) => window.__render(o, t), st);
          writeFileSync(resolve(dir, `${engine === "three" ? "three" : engine}-${tag(st)}.png`), Buffer.from(png.split(",")[1], "base64"));
        }
        if (engine !== "three") console.log(`  ${w}x${h}: ${await page.evaluate(() => window.__backend)}`);
      }
    } finally {
      await page.close();
    }
  };
  await withVite(async (url, browser) => {
    if (THREE) {
      console.log(`three.js marquee: ${STATES.length} states × ${SIZES.length} sizes`);
      await capture(url, browser, "three");
    }
    const chrome = await launchWebChrome(chromium);
    try {
      for (const b of builds.slice(1)) {
        console.log(`Rust marquee in Chrome (${b})`);
        await capture(url, chrome, b);
      }
    } finally {
      await chrome.close();
    }
  });
  return compareBuilds(builds, "marquee: ");
}

// ── Rust engine (native) ────────────────────────────────────────────────────
console.log(`\nRust (native): ${files.length} designs`);
const rendered = spawnSync("cargo", ["run", "-q", "--release", "-p", "card3d-tools", "--bin", "render", "--", OUT, ...files], {
  cwd: ROOT,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, CARD3D_QUALITY: QUALITY, CARD3D_FIT: FIT },
});
if (rendered.status !== 0) process.exit(rendered.status ?? 1);
const pending = new Map(); // design → missing features
for (const line of rendered.stdout.trim().split("\n")) {
  const [name, missing] = line.split("\t");
  if (missing !== "-") pending.set(name, missing.split(", "));
}
const ready = files.filter((f) => !pending.has(basename(f, ".json")));

if (THREE) console.log(`three.js reference: ${ready.length} designs`);
if (THREE)
  await withVite(async (url, browser) => {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.log("page error:", e.message));
    for (const f of ready) {
      const name = basename(f, ".json");
      await page.goto(`${url}?w=${W}&h=${H}&quality=${QUALITY}&fit=${FIT}&design=${encodeURIComponent(`/@fs${f}`)}`);
      await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 60000 });
      const state = await page.evaluate(() => window.__ready);
      if (state !== true) throw new Error(`${name}: ${state}`);
      for (const [pose, e] of Object.entries(POSES)) {
        const png = await page.evaluate((e) => window.__render(e), e);
        writeFileSync(resolve(OUT, name, `three-${pose}.png`), Buffer.from(png.split(",")[1], "base64"));
      }
    }
  });

// ── Rust engine in Chrome (WebGPU / WebGL 2) ────────────────────────────────
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
};
async function captureWeb(backend) {
  const server = createServer(async (q, s) => {
    let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = p.startsWith("/@abs/") ? p.slice(5) : resolve(ROOT, "." + p);
    try {
      const body = await readFile(file);
      s.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      s.writeHead(404).end();
    }
  }).listen(0);
  const browser = await launchWebChrome(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.log("page error:", e.message));
    for (const f of ready) {
      const name = basename(f, ".json");
      await page.goto(
        `http://localhost:${server.address().port}/crates/card3d-web/web/?w=${W}&h=${H}&quality=${QUALITY}&fit=${FIT}&backend=${backend}&design=${encodeURIComponent(`/@abs${f}`)}`,
      );
      await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 60000 });
      const state = await page.evaluate(() => window.__ready);
      if (state !== true) throw new Error(`${backend} ${name}: ${state}`);
      for (const [pose, e] of Object.entries(POSES)) {
        const png = await page.evaluate((e) => window.__render(e), e);
        writeFileSync(resolve(OUT, name, `${backend}-${pose}.png`), Buffer.from(png.split(",")[1], "base64"));
      }
      // A lost WebGPU device falls back to WebGL (loader.js): the renders would then be the other build's.
      const running = await page.evaluate(() => window.__card?.backend);
      if (running !== backend) throw new Error(`${name}: asked for ${backend}, but the page runs ${running} (fell back?)`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}
const builds = ["rust", ...(flag("--web") ? ["webgpu"] : []), ...(flag("--webgl") ? ["webgl"] : [])];
for (const b of builds.slice(1)) {
  console.log(`Rust in Chrome (${b}): ${ready.length} designs`);
  await captureWeb(b);
}

// ── compare ──────────────────────────────────────────────────────────────────
const status = compareBuilds(builds);
if (pending.size) {
  const byFeature = new Map();
  for (const missing of pending.values()) for (const m of missing) byFeature.set(m, (byFeature.get(m) ?? 0) + 1);
  console.log(`\nPending: ${pending.size} of ${files.length} designs use features not ported yet:`);
  for (const [m, n] of [...byFeature].sort((a, b) => b[1] - a[1])) console.log(`  ${m.padEnd(22)} ${n}`);
}
writeFileSync(resolve(OUT, "pending.json"), JSON.stringify(Object.fromEntries(pending), null, 1));
process.exit(status);

/** Each build against the reference (`BASE`); without the archive, the web builds against the native render. */
function compareBuilds(builds, label = "") {
  const against = builds.filter((b) => b !== BASE);
  if (!against.length) {
    console.log(`\nNothing to compare with ${BASE_NAME}: pass --web and/or --webgl.`);
    return 0;
  }
  let status = 0;
  for (const b of against) {
    console.log(`\n── ${label}${b} vs ${BASE_NAME} ──`);
    const r = spawnSync("cargo", ["run", "-q", "--release", "-p", "card3d-tools", "--bin", "compare", "--", OUT, BASE, b], { cwd: ROOT, stdio: "inherit" });
    status ||= r.status ?? 1;
  }
  if (!THREE) console.log(`\n(No three.js archive: these compare the engine's builds with each other, not with three.js.)`);
  return status;
}
