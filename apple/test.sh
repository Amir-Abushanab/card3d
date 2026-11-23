#!/usr/bin/env bash
# The Swift package's tests on macOS: the engine's native renders of the test designs (crates/card3d-tools
# `render`, the comparison harness's renderer) as the reference, then `swift test`, whose pixel tests
# draw the same designs through the Swift package and the C ABI and compare.
#
#   apple/test.sh            # builds the macOS slice of the XCFramework first when it's missing
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
ref="$root/target/apple-reference"

[[ -d "$here/Card3DFFI.xcframework" ]] || CARD3D_TARGETS="aarch64-apple-darwin" "$here/build-xcframework.sh"

designs=(brushed-silver holo-front glass-clear face-liquid-metal-mark scene-floor sticker-gif)
cargo run --quiet --release --manifest-path "$root/Cargo.toml" -p card3d-tools --bin render -- "$ref" \
  $(printf "$root/crates/card3d-tools/designs/%s.json " "${designs[@]}") >/dev/null
for d in "${designs[@]}"; do [[ -f "$ref/$d/rust-front.png" ]] || { echo "no reference for $d"; exit 1; }; done

cd "$here"
CARD3D_REFERENCE_DIR="$ref" swift test --scratch-path "$root/target/apple-swiftpm" "$@"
