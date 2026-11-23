#!/usr/bin/env bash
# Builds the Android library: the card engine as a shared library (crates/card3d-ffi, `libcard3d.so`)
# for each ABI into card3d/src/main/jniLibs/ (build output, gitignored), then with Gradle the AAR
# (card3d/build/outputs/aar/card3d-release.aar) and the example app's APK.
#
#   android/build.sh                          # arm64-v8a (phones, Apple-silicon emulators)
#   CARD3D_ABIS="arm64-v8a x86_64" android/build.sh   # also Intel emulators
#   CARD3D_SKIP_RUST=1 android/build.sh       # Gradle only (the .so files already built)
#   CARD3D_SKIP_GRADLE=1 android/build.sh     # the .so files only
#   CARD3D_CLEAN=1 android/build.sh           # drop each target's intermediate Rust files once copied
#   GRADLE_FLAGS=--offline android/build.sh   # extra Gradle flags
#
# Needs Rust (missing Android targets are added with `rustup target add`), the Android SDK
# (ANDROID_HOME, default ~/Library/Android/sdk) with an NDK (ANDROID_NDK_HOME, default the newest in
# $ANDROID_HOME/ndk) and JDK 17+.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
abis=(${CARD3D_ABIS:-arm64-v8a})
# The library's minSdk: the NDK's clang wrapper for it links against that API level.
api=26

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk="${ANDROID_NDK_HOME:-$(ls -d "$sdk"/ndk/*/ 2>/dev/null | sort -V | tail -1)}"
ndk="${ndk%/}"
case "$(uname -s)" in
  Darwin) host=darwin-x86_64 ;;
  Linux) host=linux-x86_64 ;;
  *) echo "unsupported host $(uname -s)"; exit 1 ;;
esac
bin="$ndk/toolchains/llvm/prebuilt/$host/bin"

if [[ -z "${CARD3D_SKIP_RUST:-}" ]]; then
  [[ -x "$bin/clang" ]] || { echo "no NDK at $ndk (set ANDROID_NDK_HOME)"; exit 1; }
  installed="$(rustup target list --installed)"
  for abi in "${abis[@]}"; do
    case "$abi" in
      arm64-v8a) t=aarch64-linux-android ;;
      x86_64) t=x86_64-linux-android ;;
      *) echo "unsupported ABI $abi (arm64-v8a, x86_64)"; exit 1 ;;
    esac
    grep -qx "$t" <<<"$installed" || rustup target add "$t"
    echo "building $t ($abi)"
    T="$(tr '[:lower:]-' '[:upper:]_' <<<"$t")"
    u="${t//-/_}"
    # The NDK's clang links (and compiles any C a dependency builds); 16 KB pages (Android 15+
    # devices may use them; Play requires it); no local paths in the library.
    export "CARGO_TARGET_${T}_LINKER=$bin/$t$api-clang"
    export "CC_$u=$bin/$t$api-clang" "AR_$u=$bin/llvm-ar"
    export "CARGO_TARGET_${T}_RUSTFLAGS=-C link-arg=-Wl,-z,max-page-size=16384 --remap-path-prefix=$root=. --remap-path-prefix=$HOME/.cargo=~/.cargo"
    cargo rustc --quiet --manifest-path "$root/Cargo.toml" -p card3d-ffi --lib --profile native --target "$t" --crate-type cdylib
    mkdir -p "$here/card3d/src/main/jniLibs/$abi"
    # Symbols out, the exported JNI and C functions stay.
    "$bin/llvm-strip" --strip-unneeded -o "$here/card3d/src/main/jniLibs/$abi/libcard3d.so" "$root/target/$t/native/libcard3d.so"
    if [[ -n "${CARD3D_CLEAN:-}" ]]; then rm -rf "$root/target/$t"; fi
  done
fi

if [[ -z "${CARD3D_SKIP_GRADLE:-}" ]]; then
  [[ -f "$here/local.properties" ]] || echo "sdk.dir=$sdk" >"$here/local.properties"
  (cd "$here" && ./gradlew ${GRADLE_FLAGS:-} --quiet :card3d:assembleRelease :example:assembleDebug)
fi

echo
for abi in "${abis[@]}"; do
  so="$here/card3d/src/main/jniLibs/$abi/libcard3d.so"
  [[ -f "$so" ]] && printf '%-44s %6.1f MB (%.1f MB gzipped)\n' "jniLibs/$abi/libcard3d.so" "$(echo "$(wc -c <"$so") / 1048576" | bc -l)" "$(echo "$(gzip -c "$so" | wc -c) / 1048576" | bc -l)"
done
for f in card3d/build/outputs/aar/card3d-release.aar example/build/outputs/apk/debug/example-debug.apk; do
  [[ -f "$here/$f" ]] && printf '%-44s %6.1f MB\n' "$f" "$(echo "$(wc -c <"$here/$f") / 1048576" | bc -l)"
done
exit 0
