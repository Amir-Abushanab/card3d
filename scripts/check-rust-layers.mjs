#!/usr/bin/env node
// The Rust crates' layering (scripts/check-rust.sh; the TypeScript side's dependency-cruiser rules,
// for Cargo). Two checks, from `cargo metadata` and `cargo tree` (offline once `cargo fetch` has run):
//
// 1. Which of our crates may depend on which, directly or through another, in any kind (normal,
//    build, dev): the engine on none of them (it has no platform code), the hosts on the engine, the
//    C ABI on the engine and the native host, the tools on the engine and the native host. A new
//    crate needs an entry in LAYERS.
// 2. What must not reach a shipped build (normal dependencies, for the build's targets and features):
//    serde in any of them (the engine has its own JSON reader: it cost the web build too much), and
//    in the web builds the native host's crates and the `validate` feature's (the web validates in
//    TypeScript).
//
//   node scripts/check-rust-layers.mjs
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const cargo = (args) => execFileSync("cargo", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "inherit"] });

const LAYERS = {
  "card3d-engine": [],
  "card3d-native": ["card3d-engine"],
  "card3d-web": ["card3d-engine"],
  "card3d-ffi": ["card3d-engine", "card3d-native"],
  "card3d-tools": ["card3d-engine", "card3d-native"],
};

const SERDE = ["serde", "serde_core", "serde_derive", "serde_json"];
// The native host's (canvases, images, fonts), the validator's (`validate`) and the tools'.
const NOT_ON_THE_WEB = [...SERDE, "tiny-skia", "image", "png", "ab_glyph", "ttf-parser", "wuff", "url", "idna", "icu_properties", "pollster", "winit"];
const BUILDS = [
  { name: "web (WebGPU)", args: ["-p", "card3d-web", "--target", "wasm32-unknown-unknown"], banned: NOT_ON_THE_WEB },
  {
    name: "web (WebGL)",
    args: ["-p", "card3d-web", "--target", "wasm32-unknown-unknown", "--no-default-features", "--features", "webgl"],
    banned: NOT_ON_THE_WEB,
  },
  { name: "engine (all features)", args: ["-p", "card3d-engine", "--all-features", "--target", "all"], banned: SERDE },
  { name: "Apple (card3d-ffi, iOS)", args: ["-p", "card3d-ffi", "--target", "aarch64-apple-ios"], banned: SERDE },
  { name: "Android (card3d-ffi)", args: ["-p", "card3d-ffi", "--target", "aarch64-linux-android"], banned: SERDE },
];

const problems = [];

// 1. Our crates' dependencies on each other.
const meta = JSON.parse(cargo(["metadata", "--format-version", "1", "--no-deps", "--locked"]));
const members = new Map(meta.packages.map((p) => [p.name, [...new Set(p.dependencies.filter((d) => d.path).map((d) => d.name))]]));
for (const name of members.keys()) {
  if (!(name in LAYERS)) {
    problems.push(`${name}: not in LAYERS (scripts/check-rust-layers.mjs): say which of our crates it may depend on`);
    continue;
  }
  // Everything it reaches through our own crates.
  const reached = new Set();
  const visit = (n, via) => {
    for (const d of members.get(n) ?? []) {
      if (reached.has(d)) continue;
      reached.add(d);
      if (!LAYERS[name].includes(d))
        problems.push(
          `${name} depends on ${d}${via.length ? ` (through ${via.join(" → ")})` : ""}; it may only use ${LAYERS[name].join(", ") || "none of our crates"}`,
        );
      visit(d, [...via, d]);
    }
  };
  visit(name, []);
}

// 2. What reaches each shipped build.
for (const b of BUILDS) {
  const out = cargo(["tree", "--locked", "-e", "normal", "--prefix", "none", "--format", "{p}", ...b.args]);
  const crates = new Set(
    out
      .split("\n")
      .map((l) => l.trim().split(" ")[0])
      .filter(Boolean),
  );
  for (const c of b.banned) if (crates.has(c)) problems.push(`${b.name}: ${c} is in the build (cargo tree ${b.args.join(" ")} -i ${c})`);
}

if (problems.length) {
  console.error(`Rust layering: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Rust layering ok: ${members.size} crates; ${BUILDS.length} builds free of ${new Set(BUILDS.flatMap((b) => b.banned)).size} banned crates`);
