#!/usr/bin/env bash
# Builds the card engine's static library for Apple platforms and packages it as
# apple/Card3DFFI.xcframework (build output, gitignored), the binary target of the Card3D Swift package.
#
#   apple/build-xcframework.sh                 # iOS device, iOS simulator, macOS (all arm64)
#   CARD3D_TARGETS="aarch64-apple-darwin" apple/build-xcframework.sh   # rebuild a subset; the other slices
#                                              # built earlier (target/apple/<target>/) are packaged as they are
#   CARD3D_CLEAN=1 apple/build-xcframework.sh  # drop each target's intermediate files once its library is copied
#
# Also: regenerates crates/card3d-ffi/include/card3d.h with cbindgen (when installed: `cargo install
# cbindgen`), copies the scene environments the native host reads and THIRD_PARTY_NOTICES.md into the
# package's resources, and prints each slice's size.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
ffi="$root/crates/card3d-ffi"
out="$here/Card3DFFI.xcframework"
work="$root/target/apple"
all=(aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin)
targets=(${CARD3D_TARGETS:-${all[*]}})

# The deployment targets Package.swift declares; the objects are tagged with them.
export IPHONEOS_DEPLOYMENT_TARGET=17.0
export MACOSX_DEPLOYMENT_TARGET=14.0

installed="$(rustup target list --installed)"
for t in "${targets[@]}"; do
  grep -qx "$t" <<<"$installed" || rustup target add "$t"
done

# The header, from src/lib.rs.
if command -v cbindgen >/dev/null; then
  before="$(shasum "$ffi/include/card3d.h" 2>/dev/null || true)"
  (cd "$ffi" && cbindgen --quiet --config cbindgen.toml --output include/card3d.h)
  [[ "$before" == "$(shasum "$ffi/include/card3d.h")" ]] || echo "note: include/card3d.h was out of date and has been regenerated"
else
  echo "note: cbindgen not installed; using the committed include/card3d.h"
fi

rm -rf "$work/headers" && mkdir -p "$work/headers"
cp "$ffi/include/card3d.h" "$work/headers/"
cat >"$work/headers/module.modulemap" <<'EOF'
module Card3DFFI {
    header "card3d.h"
    export *
}
EOF

for t in "${targets[@]}"; do
  echo "building $t"
  # --remap-path-prefix: the library doesn't embed local paths (as the web builds).
  RUSTFLAGS="--remap-path-prefix=$root=. --remap-path-prefix=$HOME/.cargo=~/.cargo ${RUSTFLAGS:-}" \
    cargo rustc --quiet --manifest-path "$root/Cargo.toml" -p card3d-ffi --lib --profile native --target "$t" --crate-type staticlib
  mkdir -p "$work/$t"
  cp "$root/target/$t/native/libcard3d.a" "$work/$t/libcard3d.a"
  # Debug symbols out (the app's link strips the rest).
  xcrun strip -S "$work/$t/libcard3d.a" 2>/dev/null
  if [[ -n "${CARD3D_CLEAN:-}" ]]; then rm -rf "$root/target/$t"; fi
done

libs=()
packaged=()
for t in "${all[@]}"; do
  [[ -f "$work/$t/libcard3d.a" ]] || continue
  libs+=(-library "$work/$t/libcard3d.a" -headers "$work/headers")
  packaged+=("$t")
  [[ " ${targets[*]} " == *" $t "* ]] || echo "note: $t packaged from an earlier build"
done
rm -rf "$out"
xcodebuild -create-xcframework "${libs[@]}" -output "$out" >/dev/null

# What the native host reads from disk at run time: the scene environments (`NativeHost::environments`).
# The card fonts are compiled into the library.
res="$here/Sources/Card3D/Resources/environments"
rm -rf "$res" && mkdir -p "$res"
cp "$root/packages/core/assets/environments/"*.webp "$res/"
# The licences of the third-party code, fonts and environments in the library and the package
# (Card3DNotices.url): the repository's notices, whose Rust section `pnpm notices` regenerates.
cp "$root/THIRD_PARTY_NOTICES.md" "$here/Sources/Card3D/Resources/THIRD_PARTY_NOTICES.md"

echo
echo "$out"
printf '%-28s %10s %14s\n' "slice" "libcard3d.a" "gzipped"
for t in "${packaged[@]}"; do
  a="$work/$t/libcard3d.a"
  printf '%-28s %8.1f MB %11.1f MB\n' "$t" "$(echo "$(stat -f%z "$a") / 1048576" | bc -l)" "$(echo "$(gzip -c "$a" | wc -c) / 1048576" | bc -l)"
done
echo "(a static library holds everything; an app links only what it uses: see apple/README.md for the linked size)"
