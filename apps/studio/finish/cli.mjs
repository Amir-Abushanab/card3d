#!/usr/bin/env node
/**
 * `pnpm finish`: the no-key "describe a finish" loop for Claude Code (.claude/skills/describe-finish).
 *
 *   pnpm -s finish describe                      the design-space description (Markdown) to read first
 *   pnpm -s finish check  <design.json | ->      lint the design, print the studio link(s)
 *   pnpm -s finish render <design.json | -> [--out <dir>] [--size 1200x800] [--back] [--time 1.6] [--gpu]
 *                                                check + compile custom WGSL + front / tilt / detail PNGs
 *
 * The engine code runs from source through Vite (SSR for the checks, a dev page for the renders),
 * the renders through Playwright's Chromium (`pnpm --filter card-studio e2e:install` once). Exit code 1
 * when the design has errors. Links: http://localhost:5180/#d=… (`pnpm dev`), plus $CARD_STUDIO_URL
 * (e.g. https://card-studio.pages.dev) when set.
 */
import { createServer } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";

const HERE = import.meta.dirname;
const STUDIO = resolve(HERE, "..");
const ROOT = resolve(STUDIO, "../..");
/** pnpm runs scripts from the package root; resolve the user's paths against where they ran it. */
const CWD = process.env.INIT_CWD ?? process.cwd();
const DEV_ORIGIN = "http://localhost:5180/";

const args = process.argv.slice(2);
const [cmd, ...rest] = args;
const flag = (name) => rest.includes(`--${name}`);
const option = (name, fallback) => {
  const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  return rest[i].includes("=") ? rest[i].slice(name.length + 3) : rest[i + 1];
};
const target = rest.find((a, i) => !a.startsWith("--") && !(i > 0 && /^--(out|size|time|section)$/.test(rest[i - 1])));

const USAGE = `usage:
  pnpm -s finish describe [--section <id>]
  pnpm -s finish check <design.json | ->
  pnpm -s finish render <design.json | -> [--out <dir>] [--size 1200x800] [--back] [--time 1.6] [--gpu]`;

/** A Vite server that can load the engine's TypeScript (SSR) and serve the preview page. */
async function vite(listen) {
  const server = await createServer({
    configFile: false,
    root: HERE,
    cacheDir: resolve(STUDIO, "node_modules/.vite-finish"),
    logLevel: "error",
    appType: "mpa",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: listen ? { port: 5189, strictPort: false, host: "127.0.0.1", fs: { allow: [ROOT] }, hmr: false } : { middlewareMode: true, hmr: false, ws: false },
  });
  if (listen) await server.listen();
  return server;
}

async function readDesign(file) {
  if (!file) throw new Error(`missing <design.json>\n${USAGE}`);
  if (file === "-") {
    let s = "";
    for await (const chunk of process.stdin) s += chunk;
    return { text: s, name: "stdin" };
  }
  const path = resolve(CWD, file);
  return { text: await readFile(path, "utf8"), name: path };
}

function printIssues(title, issues) {
  if (!issues.length) return;
  console.log(`\n${title}:`);
  for (const i of issues) console.log(`  - ${i.path ? `${i.path}: ` : ""}${i.message}`);
}

async function links(core, design) {
  const { token, stripped } = await core.encodeDesignToken(design);
  const out = [`${DEV_ORIGIN}#d=${token}`];
  const deployed = process.env.CARD_STUDIO_URL?.trim();
  if (deployed) out.push(`${deployed.replace(/\/?$/, "/")}#d=${token}`);
  return { urls: out, stripped };
}

async function check(server, file) {
  const core = await server.ssrLoadModule("@card3d/core/model");
  const describe = await server.ssrLoadModule("@card3d/core/describe");
  const { text, name } = await readDesign(file);
  const lint = describe.lintDesign(text);
  console.log(`design: ${name}`);
  printIssues("errors (fix these)", lint.errors);
  printIssues("warnings", lint.warnings);
  if (!lint.design) return { lint, ok: false };
  if (!lint.errors.length && !lint.warnings.length) console.log("\nlint: ok");
  const { urls, stripped } = await links(core, lint.design);
  console.log(`\nstudio link${urls.length > 1 ? "s" : ""} (run \`pnpm dev\` for localhost):`);
  for (const u of urls) console.log(`  ${u}`);
  if (lint.design.shaders?.some((l) => l.id === "custom")) console.log("  (custom shader layers from a link open paused: click “Run it” in the studio)");
  if (stripped) console.log(`  (${stripped} inline upload(s) are not carried by links)`);
  return { lint, ok: lint.errors.length === 0 };
}

async function render(server, file) {
  const { lint, ok } = await check(server, file);
  if (!lint.design) return false;
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    throw new Error("Playwright is missing: run `pnpm install` and `pnpm --filter card-studio e2e:install`");
  }
  const [width, height] = String(option("size", "1200x800")).split("x").map(Number);
  const time = Number(option("time", "1.6"));
  const name = file === "-" ? "design" : basename(file, extname(file)).replace(/\.card$/, "");
  const out = resolve(CWD, option("out", resolve(tmpdir(), "card3d-finish", name)));
  const poses = [
    { name: "front", pitch: 0, yaw: 0 },
    { name: "tilt", pitch: -16, yaw: 32 },
    // a 3× close-up of the tilted face (its middle, clear of the chip): fine texture (brushing, grain, foil) shows here
    { name: "detail", pitch: -16, yaw: 32, zoom: 3, focus: [0.42, 0.42] },
    ...(flag("back") ? [{ name: "back", pitch: 0, yaw: 180 }] : []),
  ];

  const gpu = flag("gpu") || process.env.E2E_GL === "gpu";
  const browser = await chromium.launch({
    args: gpu ? ["--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  let compileOk = true;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
    const base = server.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:5189/";
    await page.goto(new URL("preview.html", base).href);
    await page.waitForFunction(() => window.finishReady === true, null, { timeout: 60_000 });
    const result = await page.evaluate((req) => window.finishPreview(req), { design: lint.design, width, height, poses, time });

    const compileErrors = result.compile.flatMap((c) =>
      c.errors.map((e) => ({ path: `shaders[${c.index}].code${e.line ? `:${e.line}` : ""}`, message: e.message })),
    );
    const skipped = result.skipped.filter((s) => !result.compile.some((c) => c.index === s.index && c.errors.length));
    for (const s of skipped)
      for (const e of s.errors) compileErrors.push({ path: `shaders[${s.index}] (${s.side})${e.line ? `:${e.line}` : ""}`, message: e.message });
    // The parse-level errors were already listed by the lint; show only what the GPU added.
    const fresh = compileErrors.filter((e) => !lint.errors.some((l) => l.path === e.path && l.message === e.message));
    printIssues("WGSL compile errors (fix these)", fresh);
    compileOk = compileErrors.length === 0;
    if (lint.design.shaders?.some((l) => l.id === "custom") && compileOk) console.log("\nwgsl: every custom layer compiles");
    printIssues(
      "page errors",
      pageErrors.map((message) => ({ path: "", message })),
    );

    await mkdir(out, { recursive: true });
    console.log(`\npreviews (${width}×${height}, shader clocks at ${time}s):`);
    for (const [pose, url] of Object.entries(result.images)) {
      const path = resolve(out, `${name}-${pose}.png`);
      await writeFile(path, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
      console.log(`  ${pose}: ${path}`);
    }
    await writeFile(resolve(out, `${name}.card.json`), JSON.stringify(lint.design, null, 2));
  } finally {
    await browser.close();
  }
  return ok && compileOk;
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return true;
  }
  if (!["describe", "check", "render"].includes(cmd)) throw new Error(`unknown command "${cmd}"\n${USAGE}`);
  const server = await vite(cmd === "render");
  try {
    if (cmd === "describe") {
      const d = await server.ssrLoadModule("@card3d/core/describe");
      const section = option("section");
      if (section) {
        const s = d.designSpaceSections().find((x) => x.id === section);
        if (!s)
          throw new Error(
            `no section "${section}" (${d
              .designSpaceSections()
              .map((x) => x.id)
              .join(", ")})`,
          );
        process.stdout.write(`## ${s.title}\n\n${s.body}\n`);
      } else process.stdout.write(d.describeDesignSpace());
      return true;
    }
    if (cmd === "check") return (await check(server, target)).ok;
    return await render(server, target);
  } finally {
    await server.close();
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err) => {
    console.error(`finish: ${err.message ?? err}`);
    process.exit(2);
  },
);
