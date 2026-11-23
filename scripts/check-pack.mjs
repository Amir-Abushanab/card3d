#!/usr/bin/env node
/**
 * Pack every @card3d package (`pnpm pack`, as `pnpm publish` would, prepack included) into a temporary
 * directory and check what would ship. Build first (`pnpm build:packages`). Nothing is published.
 *
 * - every file the published `exports` / `types` point at is in the tarball, and `workspace:`
 *   ranges were rewritten;
 * - the required files are there (LICENSE, README, dist entries, the standalone bundles and their lazy
 *   chunks, the card engine's builds, the card fonts with their licences, the scene environments,
 *   THIRD_PARTY_NOTICES.md wherever fonts, environments or the engine ship, identical to the
 *   repository's, with its generated Rust crates section);
 * - every file of the package's agent skills (`skills/`, TanStack Intent) ships, with the
 *   `tanstack-intent` keyword, and the skills' planning records (`_artifacts/`) don't;
 * - no three.js: no dependency or peer on it, no packed module importing it, no three.js code in a
 *   bundle (the three.js engine is in the local archive, .archive/three-engine/, since phase 9);
 * - nothing workspace-only is: sources, tests, dev/, the local-pack loader, .reference/,
 *   docs/spec/, build helpers, tarballs;
 * - no packed text file mentions the local pack's dev-server path, or the local pack's own names.
 *
 * Prints each package's file list, grouped by directory, with sizes. `--list` prints every file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const LIST = process.argv.includes("--list");
const packages = ["core", "element", "react"];

const REQUIRED = {
  core: [
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/fonts.js",
    "dist/standalone.d.ts",
    "dist/standalone/card3d.standalone.js",
    "assets/fonts/inter-latin-wght-normal.woff2",
    "assets/fonts/licenses/inter-OFL.txt",
    "assets/environments/softbox.webp",
    "assets/environments/sunset.webp",
    "dist/describe.js",
    "dist/describe.d.ts",
    "dist/print.js",
    "dist/print.d.ts",
    "dist/marquee.js",
    "dist/marquee.d.ts",
    /^dist\/standalone\/card3d-marquee-[\w-]+\.js$/,
    /^dist\/standalone\/card3d-ar-[\w-]+\.js$/,
    // The Rust engine: its loader and both builds (crates/card3d-web/build-web.sh), beside dist/.
    "dist/engine.js",
    "dist/engine.d.ts",
    "dist/model.js",
    "dist/model.d.ts",
    "dist/editor.js",
    "dist/editor.d.ts",
    "wasm/loader.js",
    "wasm/loader.d.ts",
    "wasm/gif-stickers.js",
    "wasm/pkg/card3d_web.js",
    "wasm/pkg-webgl/card3d_web.js",
    /^wasm\/pkg\/card3d_web_bg\.[0-9a-f]{12}\.wasm$/,
    /^wasm\/pkg-webgl\/card3d_web_bg\.[0-9a-f]{12}\.wasm$/,
    /^wasm\/pkg\/split_shape\.[0-9a-f]{12}\.wasm$/,
  ],
  element: [
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/standalone.d.ts",
    "dist/standalone/metal-card.js",
    "dist/standalone/metal-card.iife.js",
    "dist/standalone/fonts/inter-latin-wght-normal.woff2",
    "dist/standalone/fonts/licenses/inter-OFL.txt",
    "dist/standalone/environments/softbox.webp",
    /^dist\/standalone\/metal-card-marquee-[\w-]+\.js$/,
    /^dist\/standalone\/metal-card-ar-[\w-]+\.js$/,
    "dist/standalone/engine/pkg/card3d_web.js",
    "dist/standalone/engine/pkg-webgl/card3d_web.js",
  ],
  react: ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"],
};
/** Paths that must never ship. */
const FORBIDDEN = [
  /(^|\/)\.reference(\/|$)/,
  /(^|\/)docs\/spec(\/|$)/,
  /(^|\/)_artifacts(\/|$)/,
  /(^|\/)dev\/local-pack/,
  /^src\//,
  /(^|\/)build\//,
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)reference\.(js|d\.ts|js\.map)$/,
  /__dev__/,
  /\.tgz$/,
  /(^|\/)tsdown\.config|vite\..*config/,
];
/**
 * Text that must not appear in any packed text file: the dev server's path to the local asset pack
 * (only its loader, which never ships, requests it) and, when a local pack is present, the names its
 * `site.json` lists (name, owner and host), read at run time so this file names nothing.
 */
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FORBIDDEN_TEXT = [/\/@ref\//];
const siteFile = join(root, ".reference/pack/site.json");
if (existsSync(siteFile)) {
  const site = JSON.parse(readFileSync(siteFile, "utf8"));
  for (const word of [site.name, site.owner]) if (word) FORBIDDEN_TEXT.push(new RegExp(`\\b${escape(word)}\\b`, "i"));
  if (site.url) FORBIDDEN_TEXT.push(new RegExp(escape(new URL(site.url).host.replace(/^www\./, "")), "i"));
} else console.log("(no local pack: its names check is skipped)");

/**
 * three.js in a packed file: an import of it (ESM, a dynamic import, a type import in a .d.ts), or its
 * code in a bundle (property names three's classes set on every instance, which minifiers keep).
 */
const THREE_IMPORT = /\bfrom\s*["'](?:three|@types\/three)(?:\/[^"']*)?["']|\bimport\(\s*["']three(?:\/[^"']*)?["']\s*\)|\brequire\(\s*["']three["']\s*\)/;
const THREE_CODE = /\bis(?:WebGLRenderer|BufferGeometry|Object3D|ShaderMaterial)\b/;

const tmp = mkdtempSync(join(tmpdir(), "card3d-pack-"));
let failed = false;
const fail = (pkg, msg) => {
  failed = true;
  console.error(`✗ @card3d/${pkg}: ${msg}`);
};

const walk = (dir, base = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]));
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

try {
  for (const pkg of packages) {
    const dir = join(root, "packages", pkg);
    const out = join(tmp, pkg);
    execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
    const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
    execFileSync("tar", ["-xzf", join(out, tgz), "-C", out]);
    const pkgDir = join(out, "package");
    const files = walk(pkgDir).sort();
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

    // A string is an exact path; a RegExp matches a hashed file name (the standalone extras chunk).
    for (const f of REQUIRED[pkg]) if (typeof f === "string" ? !files.includes(f) : !files.some((x) => f.test(x))) fail(pkg, `missing ${f}`);
    for (const f of files) if (FORBIDDEN.some((re) => re.test(f))) fail(pkg, `ships ${f}`);
    // The agent skills (packages/<pkg>/skills/<name>/SKILL.md and references/): every file ships.
    const skillsDir = join(dir, "skills");
    if (existsSync(skillsDir)) {
      for (const f of walk(skillsDir, "skills/")) if (!files.includes(f)) fail(pkg, `agent skill file ${f} is not in the tarball`);
      if (!manifest.keywords?.includes("tanstack-intent")) fail(pkg, "ships agent skills without the tanstack-intent keyword");
    }
    // The notices must be the repository's current file, Rust crates section included (the wasm builds'
    // crates: scripts/third-party-rust.mjs).
    if (files.includes("THIRD_PARTY_NOTICES.md")) {
      const notices = readFileSync(join(pkgDir, "THIRD_PARTY_NOTICES.md"), "utf8");
      if (notices !== readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")) fail(pkg, "THIRD_PARTY_NOTICES.md differs from the repository's");
      if (!/<!-- BEGIN rust-crates[^]*`wgpu`[^]*<!-- END rust-crates -->/.test(notices)) fail(pkg, "THIRD_PARTY_NOTICES.md has no Rust crates section");
    }

    // exports → files (publishConfig applied by pnpm)
    const targets = [];
    const collect = (v) => (typeof v === "string" ? targets.push(v) : v && typeof v === "object" && Object.values(v).forEach(collect));
    collect(manifest.exports);
    for (const t of targets) {
      if (t.includes("*")) {
        const prefix = t.slice(2, t.indexOf("*"));
        if (!files.some((f) => f.startsWith(prefix))) fail(pkg, `export pattern ${t} matches nothing`);
      } else if (!files.includes(t.replace(/^\.\//, ""))) fail(pkg, `export target ${t} is not in the tarball`);
      if (/\/src\//.test(t)) fail(pkg, `export points at sources: ${t}`);
    }
    if (manifest.exports?.["./reference"]) fail(pkg, "exports the workspace-only ./reference");
    for (const field of ["dependencies", "peerDependencies"])
      for (const [name, range] of Object.entries(manifest[field] ?? {}))
        if (String(range).startsWith("workspace:")) fail(pkg, `${field}.${name} is still ${range}`);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "peerDependenciesMeta"])
      for (const name of Object.keys(manifest[field] ?? {}))
        if (/^(three|@types\/three)$/.test(name)) fail(pkg, `${field}.${name}: three.js is not a dependency`);
    if (manifest.private) fail(pkg, "is private");
    if (manifest.license !== "MIT") fail(pkg, "license is not MIT");
    if (!String(manifest.repository?.url ?? "").includes("github.com/Amir-Abushanab/card3d")) fail(pkg, "repository URL");

    for (const f of files) {
      if (!/\.(js|mjs|cjs|ts|map|json|md|txt)$/.test(f)) continue;
      const text = readFileSync(join(pkgDir, f), "utf8");
      for (const re of FORBIDDEN_TEXT) if (re.test(text)) fail(pkg, `${f} contains ${re}`);
      if (/\.(js|mjs|cjs|ts)$/.test(f) && THREE_IMPORT.test(text)) fail(pkg, `${f} imports three.js`);
      if (/\.(js|mjs|cjs)$/.test(f) && THREE_CODE.test(text)) fail(pkg, `${f} carries three.js code (${text.match(THREE_CODE)[0]})`);
    }

    // summary: files grouped by directory
    const groups = new Map();
    let total = 0;
    for (const f of files) {
      const size = statSync(join(pkgDir, f)).size;
      total += size;
      const g = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "./";
      const e = groups.get(g) ?? { n: 0, size: 0 };
      e.n++;
      e.size += size;
      groups.set(g, e);
    }
    console.log(`\n@card3d/${pkg}@${manifest.version}  ${files.length} files, ${kb(total)} unpacked, tarball ${kb(statSync(join(out, tgz)).size)}`);
    for (const [g, e] of [...groups].sort()) console.log(`  ${g.padEnd(34)} ${String(e.n).padStart(4)} files  ${kb(e.size).padStart(9)}`);
    if (LIST) for (const f of files) console.log(`    ${f}`);
    const deps = Object.entries(manifest.dependencies ?? {})
      .map(([k, v]) => `${k}@${v}`)
      .join(", ");
    console.log(
      `  exports: ${Object.keys(manifest.exports ?? {}).join(", ")}${deps ? `\n  dependencies: ${deps}` : ""}\n  peers: ${Object.keys(manifest.peerDependencies ?? {}).join(", ")}`,
    );
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("\n✓ pack check passed (nothing was published)");
