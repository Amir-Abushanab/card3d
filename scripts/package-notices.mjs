#!/usr/bin/env node
/**
 * Copy the repository's LICENSE (and, with --notices, THIRD_PARTY_NOTICES.md) into the current
 * package directory. Run as each package's `prepack`, so `pnpm pack` / `pnpm publish` always ship them;
 * the copies are gitignored (packages/*\/LICENSE, packages/*\/THIRD_PARTY_NOTICES.md).
 *
 * --notices: for packages that ship third-party code or files (the card fonts, the scene environments,
 * the card engine's code ported from Paper Shaders, three.js, drei and Earcut, and the Rust crates
 * compiled into its wasm builds, whose section scripts/third-party-rust.mjs generates).
 */
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = ["LICENSE", ...(process.argv.includes("--notices") ? ["THIRD_PARTY_NOTICES.md"] : [])];
for (const f of files) copyFileSync(resolve(root, f), resolve(process.cwd(), f));
