#!/usr/bin/env node
// Outdated Rust dependencies, with a cooldown (the TypeScript side's ncu, for Cargo): lists every
// direct dependency of the workspace's crates whose locked version is behind the newest release
// published at least three days ago, and with --upgrade moves them there. A release younger than the
// cooldown is shown but never applied: a compromised or broken release is usually yanked within days.
// Uses the network (crates.io's API, at most one request a second), so it isn't part of
// scripts/check-rust.sh.
//
//   node scripts/rust-outdated.mjs                 list (compatible: `cargo update` takes it; newest: may
//                                                  need a new requirement in Cargo.toml)
//   node scripts/rust-outdated.mjs --upgrade       apply: `cargo update --precise` for compatible
//                                                  releases; a new requirement (same precision: "30" →
//                                                  "31") plus `cargo update --precise` for the rest
//   node scripts/rust-outdated.mjs --upgrade --compatible-only
//   node scripts/rust-outdated.mjs --upgrade --pinned   also exact (`=`) requirements: wasm-bindgen's
//                                                  must match the wasm-bindgen CLI (build-web.sh, CI)
//   node scripts/rust-outdated.mjs --cooldown-days 7
//
// Only the direct dependencies wait out the cooldown: what a new release pulls in resolves as Cargo
// resolves it. Afterwards: scripts/check-rust.sh, cargo test, the web build's sizes, and
// `node scripts/third-party-rust.mjs` when the dependency tree changed (THIRD_PARTY_NOTICES.md).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const COOLDOWN_DAYS = flag("--cooldown-days") ? Number(args[args.indexOf("--cooldown-days") + 1]) : 3;
const UPGRADE = flag("--upgrade");
const PINNED = flag("--pinned");
const COMPATIBLE_ONLY = flag("--compatible-only");
// crates.io asks API clients for a User-Agent; this one names the script only.
const USER_AGENT = "rust-outdated.mjs (cargo workspace dependency check)";
const cutoff = Date.now() - COOLDOWN_DAYS * 86400e3;

const cargo = (a, opts = {}) => execFileSync("cargo", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "inherit"], ...opts });

// ── versions ─────────────────────────────────────────────────────────────────
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? "" } : null;
};
const cmp = (a, b) => {
  const x = parse(a),
    y = parse(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  return x.pre === "" ? 1 : y.pre === "" ? -1 : x.pre < y.pre ? -1 : 1;
};
// Cargo's requirement as written: "1", "0.25", "2.5", "=0.2.130", "^1.2", "~1.2" (one comparator).
const reqParts = (req) => {
  const m = /^\s*([=^~]?)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(req);
  if (!m) return null;
  return { op: m[1] || "^", nums: [m[2], m[3], m[4]].filter((n) => n !== undefined).map(Number) };
};
const matches = (v, req) => {
  const r = reqParts(req),
    p = parse(v);
  if (!r || !p || p.pre) return false;
  const [maj, min = 0, pat = 0] = r.nums;
  const ge = cmp(v, `${maj}.${min}.${pat}`) >= 0;
  if (r.op === "=") return r.nums.length === 3 ? cmp(v, `${maj}.${min}.${pat}`) === 0 : p.major === maj && (r.nums.length < 2 || p.minor === min);
  if (r.op === "~") return ge && p.major === maj && (r.nums.length < 2 || p.minor === min);
  // Caret: the leftmost non-zero component written stays.
  if (maj > 0 || r.nums.length === 1) return ge && p.major === maj;
  if (min > 0 || r.nums.length === 2) return ge && p.major === 0 && p.minor === min;
  return ge && p.major === 0 && p.minor === 0 && p.patch === pat;
};
// The same requirement at the same precision for a newer version: "30" → "31", "0.25" → "0.26".
const bumpReq = (req, v) => {
  const r = reqParts(req),
    p = parse(v);
  const nums = [p.major, p.minor, p.patch].slice(0, r.nums.length);
  return `${r.op === "^" && !req.trim().startsWith("^") ? "" : r.op}${nums.join(".")}`;
};

// ── what the workspace uses ──────────────────────────────────────────────────
const meta = JSON.parse(cargo(["metadata", "--format-version", "1", "--locked"]));
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const members = meta.packages.filter((p) => meta.workspace_members.includes(p.id));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const ROOT_MANIFEST = join(ROOT, "Cargo.toml");

// The requirement as written and the manifest that holds it (the workspace's for `workspace = true`).
function declaration(manifest, name) {
  const text = readFileSync(manifest, "utf8");
  const key = name.replace(/[-_]/g, "[-_]");
  if (new RegExp(`^${key}\\s*(\\.\\s*workspace\\s*=\\s*true|=\\s*\\{[^}\\n]*\\bworkspace\\s*=\\s*true)`, "m").test(text))
    return declaration(ROOT_MANIFEST, name);
  const m = new RegExp(`^${key}\\s*=\\s*(?:"([^"]+)"|\\{[^}\\n]*?\\bversion\\s*=\\s*"([^"]+)")`, "m").exec(text);
  return m ? { manifest, req: m[1] ?? m[2] } : null;
}

const deps = new Map(); // name → { reqs: Map(manifest → req), locked: Set }
for (const p of members) {
  const node = nodes.get(p.id);
  for (const d of p.dependencies) {
    if (!d.source?.startsWith("registry+")) continue;
    const decl = declaration(p.manifest_path, d.rename ?? d.name);
    const e = deps.get(d.name) ?? { name: d.name, reqs: new Map(), locked: new Set() };
    if (decl) e.reqs.set(decl.manifest, decl.req);
    for (const nd of node.deps) {
      const pkg = byId.get(nd.pkg);
      if (pkg.name === d.name && matches(pkg.version, decl?.req ?? d.req.replace(/^\^/, ""))) e.locked.add(pkg.version);
    }
    deps.set(d.name, e);
  }
}

// ── crates.io ────────────────────────────────────────────────────────────────
let last = 0;
async function versions(name) {
  const out = [];
  let url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/versions?per_page=100`;
  while (url) {
    const wait = last + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!res.ok) throw new Error(`crates.io: ${res.status} for ${name}`);
    const j = await res.json();
    out.push(...j.versions);
    url = j.meta?.next_page ? `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/versions${j.meta.next_page}` : null;
  }
  return out.filter((v) => !v.yanked && !parse(v.num)?.pre);
}

const rows = [];
for (const e of [...deps.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const all = await versions(e.name);
  const cooled = all
    .filter((v) => Date.parse(v.created_at) <= cutoff)
    .map((v) => v.num)
    .sort(cmp);
  const newest = all
    .map((v) => v.num)
    .sort(cmp)
    .at(-1);
  const reqs = [...e.reqs.values()];
  const locked = [...e.locked].sort(cmp).at(-1) ?? "?";
  const latest = cooled.at(-1);
  const compatible = cooled.findLast((v) => reqs.every((r) => matches(v, r)));
  const pinned = reqs.some((r) => r.trim().startsWith("="));
  const fresh = newest && latest && cmp(newest, latest) > 0 ? newest : null;
  rows.push({
    name: e.name,
    decls: e.reqs,
    reqs,
    locked,
    latest,
    compatible,
    pinned,
    fresh,
    published: Object.fromEntries(all.map((v) => [v.num, v.created_at.slice(0, 10)])),
  });
}

const outdated = rows.filter((r) => r.latest && r.locked !== "?" && cmp(r.latest, r.locked) > 0);
const pad = (s, n) => String(s ?? "").padEnd(n);
console.log(`Direct Rust dependencies: ${rows.length}; behind the newest release at least ${COOLDOWN_DAYS} days old: ${outdated.length}\n`);
if (outdated.length) {
  console.log(`${pad("crate", 26)}${pad("requirement", 14)}${pad("locked", 12)}${pad("compatible", 12)}newest`);
  for (const r of outdated) {
    const compat = r.compatible && cmp(r.compatible, r.locked) > 0 ? r.compatible : "-";
    const notes = [r.pinned ? "pinned (=)" : "", r.latest !== compat ? "needs a new requirement" : ""].filter(Boolean).join(", ");
    console.log(
      `${pad(r.name, 26)}${pad([...new Set(r.reqs)].join(" / "), 14)}${pad(r.locked, 12)}${pad(compat, 12)}${r.latest} (${r.published[r.latest]})${notes ? `  ${notes}` : ""}`,
    );
  }
}
const waiting = rows.filter((r) => r.fresh && (!r.latest || cmp(r.fresh, r.locked) > 0));
if (waiting.length) {
  console.log(`\nIn the cooldown (published less than ${COOLDOWN_DAYS} days ago, not applied):`);
  for (const r of waiting) console.log(`  ${pad(r.name, 24)}${r.fresh} (${r.published[r.fresh]})`);
}

if (!UPGRADE) {
  if (outdated.length) console.log(`\nnode scripts/rust-outdated.mjs --upgrade applies them.`);
  process.exit(0);
}

// ── upgrade ──────────────────────────────────────────────────────────────────
const lockedVersions = (name) => {
  const m = JSON.parse(cargo(["metadata", "--format-version", "1", "--locked"]));
  return m.packages.filter((p) => p.name === name && p.source?.startsWith("registry+")).map((p) => p.version);
};
const applied = [];
for (const r of outdated) {
  if (r.pinned && !PINNED) {
    console.log(`skip ${r.name}: pinned (${r.reqs.join(", ")}); --pinned upgrades it (wasm-bindgen: bump the CLI in build-web.sh and ci.yml too)`);
    continue;
  }
  const compatibleStep = r.compatible && cmp(r.compatible, r.locked) > 0 ? r.compatible : null;
  const target = COMPATIBLE_ONLY ? compatibleStep : r.latest;
  if (!target) continue;
  // A new requirement (same precision) in every manifest whose requirement the target is outside.
  const newReqs = [];
  for (const [manifest, req] of r.decls) {
    if (matches(target, req)) {
      newReqs.push(req);
      continue;
    }
    const text = readFileSync(manifest, "utf8");
    const key = r.name.replace(/[-_]/g, "[-_]");
    const re = new RegExp(`^(${key}\\s*=\\s*(?:"|\\{[^}\\n]*?\\bversion\\s*=\\s*"))${req.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&")}"`, "m");
    if (!re.test(text)) throw new Error(`${relative(ROOT, manifest)}: can't find ${r.name}'s requirement "${req}"`);
    const next = bumpReq(req, target);
    writeFileSync(manifest, text.replace(re, `$1${next}"`));
    newReqs.push(next);
    console.log(`${relative(ROOT, manifest)}: ${r.name} "${req}" → "${next}"`);
  }
  // Cargo resolves a new requirement to the newest release: then set it (or the compatible step) to
  // the cooled-down version.
  if (newReqs.some((q, i) => q !== r.reqs[i])) cargo(["update", "--workspace"], { stdio: "inherit" });
  for (const v of lockedVersions(r.name)) {
    if (v !== target && newReqs.every((q) => matches(v, q))) cargo(["update", "-p", `${r.name}@${v}`, "--precise", target], { stdio: "inherit" });
  }
  applied.push(`${r.name} ${r.locked} → ${target}`);
}
console.log(
  applied.length
    ? `\nUpgraded:\n  ${applied.join("\n  ")}\n\nNext: scripts/check-rust.sh, cargo test --workspace, crates/card3d-web/build-web.sh (sizes),\nnode scripts/third-party-rust.mjs (notices)`
    : "\nNothing to upgrade.",
);
