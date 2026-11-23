#!/bin/sh
# The Rust side's hygiene checks, offline and fast enough to run before every push (`pnpm check:rust`;
# CI's rust job runs it with --online). Run from anywhere:
#
#   scripts/check-rust.sh            all checks
#   scripts/check-rust.sh --online   also fetches the RustSec advisory database (else a cached copy is
#                                    used when there is one, and the advisory check is skipped when not)
#   scripts/check-rust.sh --fix      formats Rust and TOML first (cargo fmt, taplo fmt)
#
# What runs (the TypeScript tool each stands in for, in brackets):
#   cargo fmt --check, taplo fmt --check + lint     formatting, Rust and TOML (oxfmt)
#   typos                                           spelling, the whole repository (_typos.toml)
#   scripts/check-rust-layers.mjs                   which crate may use which; serde and host crates kept
#                                                   out of the shipped builds (dependency-cruiser)
#   cargo shear                                     unused dependencies (knip)
#   cargo deny check                                licences, bans, sources, advisories (deny.toml)
#   cargo clippy -D warnings                        lints (oxlint): the workspace, all targets; the two
#                                                   wasm builds when the wasm32 target is installed; the
#                                                   engine's features one by one (cargo hack) when installed
# The lint policy is [workspace.lints] in Cargo.toml. Outdated dependencies: scripts/rust-outdated.mjs
# (network, so not here).
#
# Tools: rustup component add rustfmt clippy; cargo install --locked taplo-cli@0.10.0 typos-cli@1.52.2
# cargo-shear@1.14.1 cargo-deny@0.21.0 cargo-hack@0.6.46 (the versions CI pins, .github/workflows/ci.yml).
set -eu
cd "$(dirname "$0")/.."

online=0
fix=0
for a in "$@"; do
  case $a in
    --online) online=1 ;;
    --fix) fix=1 ;;
    *) echo "usage: scripts/check-rust.sh [--online] [--fix]" >&2; exit 2 ;;
  esac
done

step() { printf '\n── %s\n' "$*"; }
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is not installed ($2)" >&2; exit 1; }
}
need cargo-deny "cargo install --locked cargo-deny@0.21.0"
need cargo-shear "cargo install --locked cargo-shear@1.14.1"
need taplo "cargo install --locked taplo-cli@0.10.0"
need typos "cargo install --locked typos-cli@1.52.2"

if [ $fix = 1 ]; then
  step "format (cargo fmt, taplo fmt)"
  cargo fmt --all
  taplo fmt
fi

step "rustfmt"
cargo fmt --all --check

step "taplo (TOML format and syntax)"
RUST_LOG=warn taplo fmt --check
RUST_LOG=warn taplo lint

step "typos"
typos

step "crate layering"
node scripts/check-rust-layers.mjs

step "cargo shear (unused dependencies)"
cargo shear

step "cargo deny (licences, bans, sources)"
cargo deny --offline check licenses bans sources

if [ $online = 1 ]; then
  step "cargo deny (advisories, fetching the RustSec database)"
  cargo deny check advisories
elif [ -d "${CARGO_HOME:-$HOME/.cargo}/advisory-dbs" ]; then
  step "cargo deny (advisories, cached RustSec database; --online refreshes it)"
  cargo deny --offline check advisories
else
  step "cargo deny (advisories): skipped, no RustSec database yet (run with --online once)"
fi

step "clippy (workspace, all targets)"
cargo clippy --workspace --all-targets --locked -- -D warnings

if rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown; then
  step "clippy (the web builds: WebGPU, WebGL)"
  cargo clippy -p card3d-web --target wasm32-unknown-unknown --locked -- -D warnings
  cargo clippy -p card3d-web --target wasm32-unknown-unknown --locked --no-default-features --features webgl -- -D warnings
else
  step "clippy (the web builds): skipped, no wasm32 target (rustup target add wasm32-unknown-unknown)"
fi

if command -v cargo-hack >/dev/null 2>&1; then
  step "clippy (the engine's features one by one, and all)"
  cargo hack clippy -p card3d-engine --each-feature --all-targets --locked -- -D warnings
else
  step "clippy (the engine's features one by one): skipped, no cargo-hack (cargo install --locked cargo-hack@0.6.46)"
fi

printf '\nRust checks passed.\n'
