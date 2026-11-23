#!/usr/bin/env bash
# The Android library's instrumented tests on a connected device or a running emulator: the engine's
# native renders of the test designs (crates/card3d-tools `render`, the comparison harness's renderer)
# as the reference, then the tests (src/androidTest), whose pixel test draws the same designs through
# Kotlin, JNI and the engine and compares. Prints each design's and pose's mean error.
#
#   android/test.sh                       # builds the .so first when it's missing (build.sh)
#   CARD3D_REFERENCE_DIR=dir android/test.sh   # reference renders from elsewhere (rendered when missing)
#   CARD3D_KEEP=1 android/test.sh         # leave the test APK installed
#   CARD3D_SAVE=1 CARD3D_KEEP=1 android/test.sh   # also keep the pixel test's renders on the device
#                                         # (adb pull /sdcard/Android/data/com.card3d.test/files/card3d-test)
#   GRADLE_FLAGS=--offline android/test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
export CARD3D_REFERENCE_DIR="${CARD3D_REFERENCE_DIR:-$root/target/android-reference}"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
adb="$sdk/platform-tools/adb"

[[ -f "$here/card3d/src/main/jniLibs/arm64-v8a/libcard3d.so" ]] || CARD3D_SKIP_GRADLE=1 "$here/build.sh"

designs=(brushed-silver holo-front glass-clear face-liquid-metal-mark scene-floor sticker-gif)
missing=0
for d in "${designs[@]}"; do [[ -f "$CARD3D_REFERENCE_DIR/$d/rust-front.png" ]] || missing=1; done
if [[ $missing == 1 ]]; then
  cargo run --quiet --release --manifest-path "$root/Cargo.toml" -p card3d-tools --bin render -- "$CARD3D_REFERENCE_DIR" \
    $(printf "$root/crates/card3d-tools/designs/%s.json " "${designs[@]}") >/dev/null
fi

[[ -f "$here/local.properties" ]] || echo "sdk.dir=$sdk" >"$here/local.properties"
(cd "$here" && ./gradlew ${GRADLE_FLAGS:-} --quiet :card3d:assembleDebugAndroidTest)
apk="$here/card3d/build/outputs/apk/androidTest/debug/card3d-debug-androidTest.apk"

"$adb" wait-for-device
"$adb" install -r -t "$apk" >/dev/null
"$adb" logcat -c
status=0
args=()
[[ -z "${CARD3D_SAVE:-}" ]] || args=(-e save 1)
out="$("$adb" shell am instrument -w ${args[@]+"${args[@]}"} com.card3d.test/androidx.test.runner.AndroidJUnitRunner)" || status=$?
echo "$out"
echo
"$adb" logcat -d -s card3d-test:I card3d:I | grep -E " (card3d-test|card3d) *:" | sed -E "s/^.*(card3d-test|card3d) *: //" | awk "!seen[\$0]++"
[[ -n "${CARD3D_KEEP:-}" ]] || "$adb" uninstall com.card3d.test >/dev/null
grep -q '^OK (' <<<"$out" && [[ $status == 0 ]]
