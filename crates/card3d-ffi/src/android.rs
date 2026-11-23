//! Android: the `ANativeWindow` a stage draws into (`Card3dSurfaceKind::AndroidWindow`), and the JNI
//! methods of the Kotlin library's `com.card3d.Native` (android/card3d). The JNI layer is thin: a
//! stage handle is the C ABI's `Card3dStage` pointer as a `long`, the calls go through the same
//! functions as the C ABI's (so panics and GPU failures stop a stage the same way), and a failure
//! becomes a `com.card3d.Card3DException` subclass thrown into Kotlin.
#![allow(unreachable_pub, reason = "the JNI methods: the JVM finds them by their symbol names, not by a Rust path")]

use crate::{Card3dStage, Card3dStageOptions, Card3dStatus, Card3dSurface, Card3dSurfaceKind};
use jni::errors::{Error as JniError, ThrowRuntimeExAndDefault};
use jni::objects::{JByteArray, JClass, JDoubleArray, JObject, JString};
use jni::refs::Reference;
use jni::strings::JNIString;
use jni::sys::{jboolean, jdouble, jint, jlong};
use jni::{Env, EnvUnowned};
use std::ffi::{c_void, CString};
use std::ptr::NonNull;
use wgpu::rwh::{AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle};

#[link(name = "android")]
unsafe extern "C" {
    fn ANativeWindow_fromSurface(env: *mut jni::sys::JNIEnv, surface: jni::sys::jobject) -> *mut c_void;
    fn ANativeWindow_acquire(window: *mut c_void);
    fn ANativeWindow_release(window: *mut c_void);
}

#[link(name = "log")]
unsafe extern "C" {
    fn __android_log_write(priority: std::ffi::c_int, tag: *const std::ffi::c_char, text: *const std::ffi::c_char) -> std::ffi::c_int;
}

/// An info line in logcat (tag `card3d`).
pub(crate) fn log(message: &str) {
    if let Ok(text) = CString::new(message) {
        // SAFETY: NUL-terminated strings; 4 is ANDROID_LOG_INFO.
        unsafe { __android_log_write(4, c"card3d".as_ptr(), text.as_ptr()) };
    }
}

/// A reference to an `ANativeWindow`, released when dropped.
pub(crate) struct Window(NonNull<c_void>);

impl Window {
    /// Takes a reference to `window` (NULL: `None`).
    ///
    /// # Safety
    /// `window` is NULL or a live `ANativeWindow`.
    pub(crate) unsafe fn acquire(window: *mut c_void) -> Option<Window> {
        let w = NonNull::new(window)?;
        ANativeWindow_acquire(w.as_ptr());
        Some(Window(w))
    }

    pub(crate) fn window_handle(&self) -> RawWindowHandle {
        RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(self.0))
    }

    pub(crate) fn display_handle(&self) -> RawDisplayHandle {
        RawDisplayHandle::Android(AndroidDisplayHandle::new())
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        // SAFETY: the reference taken in `acquire`.
        unsafe { ANativeWindow_release(self.0.as_ptr()) }
    }
}

// ── JNI helpers ──────────────────────────────────────────────────────────────

fn stage(handle: jlong) -> *mut Card3dStage {
    handle as *mut Card3dStage
}

/// Throws the `Card3DException` subclass for `status` with `message`.
fn throw<T>(env: &mut Env<'_>, (status, message): (Card3dStatus, String)) -> Result<T, JniError> {
    let class = match status {
        Card3dStatus::Design => "com/card3d/Card3DException$Design",
        Card3dStatus::Gpu => "com/card3d/Card3DException$Gpu",
        Card3dStatus::Export => "com/card3d/Card3DException$Export",
        Card3dStatus::Panic => "com/card3d/Card3DException$Engine",
        Card3dStatus::Ok | Card3dStatus::InvalidArgument => "com/card3d/Card3DException$InvalidArgument",
    };
    let _ = env.throw_new(JNIString::from(class), JNIString::from(message));
    Err(JniError::JavaException)
}

/// A nullable `String` argument.
fn optional(env: &Env<'_>, s: &JString<'_>) -> Result<Option<String>, JniError> {
    if s.is_null() {
        Ok(None)
    } else {
        s.try_to_string(env).map(Some)
    }
}

/// A `double[3]` pose argument (null: none).
fn pose(env: &Env<'_>, a: &JDoubleArray<'_>) -> Result<Option<[f64; 3]>, JniError> {
    if a.is_null() {
        return Ok(None);
    }
    let mut p = [0.0; 3];
    a.get_region(env, 0, &mut p)?;
    Ok(Some(p))
}

/// The bytes of a stage export as a `byte[]`, or the exception.
fn bytes<'a>(env: &mut Env<'a>, r: Result<Vec<u8>, (Card3dStatus, String)>) -> Result<JByteArray<'a>, JniError> {
    match r {
        Ok(b) => env.byte_array_from_slice(&b),
        Err(e) => throw(env, e),
    }
}

// ── com.card3d.Native ────────────────────────────────────────────────────────

#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_abiVersion(_env: EnvUnowned<'_>, _class: JClass<'_>) -> jint {
    crate::CARD3D_ABI_VERSION as jint
}

#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_validate<'a>(mut env: EnvUnowned<'a>, _class: JClass<'a>, json: JString<'a>) -> JString<'a> {
    env.with_env(|env| -> Result<_, JniError> {
        let json = json.try_to_string(env)?;
        match crate::validate_report(&json) {
            Ok(report) => env.new_string(report),
            Err(e) => throw(env, e),
        }
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// A new stage on `surface` (an `android.view.Surface`; null: offscreen), `width` × `height` px.
#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_newStage<'a>(
    mut env: EnvUnowned<'a>,
    _class: JClass<'a>,
    quality: jint,
    fit: jint,
    interactive: jboolean,
    intro: jboolean,
    reduced_motion: jboolean,
    rotation_x: jdouble,
    rotation_y: jdouble,
    environments: JString<'a>,
    surface: JObject<'a>,
    width: jint,
    height: jint,
) -> jlong {
    env.with_env(|env| -> Result<jlong, JniError> {
        let environments = optional(env, &environments)?.and_then(|d| CString::new(d).ok());
        let options = Card3dStageOptions {
            quality: quality.max(0) as u32,
            fit: fit.max(0) as u32,
            interactive,
            intro,
            reduced_motion,
            fit_to_viewport: false,
            rotation_x,
            rotation_y,
            environments_dir: environments.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
        };
        // The window's reference from `fromSurface` is ours; the stage takes its own.
        let window = if surface.is_null() {
            None
        } else {
            // SAFETY: `surface` is a live android.view.Surface on this thread's JNI env.
            let w = unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) };
            if w.is_null() {
                return throw(env, (Card3dStatus::Gpu, "the Surface has no window (released?)".into()));
            }
            Some(w)
        };
        let kind = if window.is_some() { Card3dSurfaceKind::AndroidWindow } else { Card3dSurfaceKind::Offscreen };
        let target =
            Card3dSurface { kind: kind as u32, handle: window.unwrap_or(std::ptr::null_mut()), width: width.max(1) as u32, height: height.max(1) as u32 };
        // SAFETY: the options and surface are valid for the call; the window is live.
        let r = unsafe { crate::new_stage(&options, &target) };
        if let Some(w) = window {
            // SAFETY: the reference `ANativeWindow_fromSurface` returned.
            unsafe { ANativeWindow_release(w) };
        }
        match r {
            Ok(s) => Ok(s as jlong),
            Err(e) => throw(env, e),
        }
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_free(_env: EnvUnowned<'_>, _class: JClass<'_>, s: jlong) {
    // SAFETY: Kotlin frees each handle once (Engine.close).
    unsafe { crate::card3d_stage_free(stage(s)) }
}

#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_setDesign<'a>(
    mut env: EnvUnowned<'a>,
    _class: JClass<'a>,
    s: jlong,
    json: JString<'a>,
    assets: JString<'a>,
) -> JString<'a> {
    env.with_env(|env| -> Result<_, JniError> {
        let json = json.try_to_string(env)?;
        let assets = optional(env, &assets)?.unwrap_or_default();
        // SAFETY: a live handle, used on its thread (Kotlin's main thread).
        let r = unsafe { crate::run(stage(s), |st| st.set_design(&json, &assets)) };
        match r {
            Ok(report) => env.new_string(report.to_json(false)),
            Err(e) => throw(env, e),
        }
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_render(mut env: EnvUnowned<'_>, _class: JClass<'_>, s: jlong) {
    env.with_env(|env| -> Result<(), JniError> {
        // SAFETY: a live handle on its thread.
        unsafe { crate::run(stage(s), |st| st.render()) }.or_else(|e| throw(env, e))
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_setQuality(mut env: EnvUnowned<'_>, _class: JClass<'_>, s: jlong, quality: jint) {
    env.with_env(|env| -> Result<(), JniError> {
        let Some(q) = crate::stage::quality(quality.max(0) as u32) else {
            return throw(env, (Card3dStatus::InvalidArgument, "quality: 0 or 1".into()));
        };
        // SAFETY: a live handle on its thread.
        unsafe { crate::run(stage(s), |st| st.set_quality(q)) }.or_else(|e| throw(env, e))
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_setLighting<'a>(mut env: EnvUnowned<'a>, _class: JClass<'a>, s: jlong, id: JString<'a>) {
    env.with_env(|env| -> Result<(), JniError> {
        let id = optional(env, &id)?;
        // SAFETY: a live handle on its thread.
        unsafe { crate::run(stage(s), |st| st.set_lighting(id.as_deref())) }.or_else(|e| throw(env, e))
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// Flags (`CARD3D_ANIMATING` …); `wake[0]` receives the ms until a scheduled change, or −1.
#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_advance<'a>(
    mut env: EnvUnowned<'a>,
    _class: JClass<'a>,
    s: jlong,
    now_ms: jdouble,
    wake: JDoubleArray<'a>,
) -> jint {
    env.with_env(|env| -> Result<jint, JniError> {
        let mut w = -1.0;
        // SAFETY: a live handle on its thread.
        let flags = unsafe { crate::card3d_stage_advance(stage(s), now_ms, &mut w) };
        if !wake.is_null() {
            wake.set_region(env, 0, &[w])?;
        }
        Ok(flags as jint)
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// The interaction's pitch and yaw (degrees) into `out[0]`, `out[1]`.
#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_rotation<'a>(mut env: EnvUnowned<'a>, _class: JClass<'a>, s: jlong, out: JDoubleArray<'a>) {
    env.with_env(|env| -> Result<(), JniError> {
        let (mut x, mut y) = (0.0, 0.0);
        // SAFETY: a live handle on its thread.
        unsafe { crate::card3d_stage_rotation(stage(s), &mut x, &mut y) };
        out.set_region(env, 0, &[x, y])
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_exportPng<'a>(
    mut env: EnvUnowned<'a>,
    _class: JClass<'a>,
    s: jlong,
    width: jint,
    height: jint,
    p: JDoubleArray<'a>,
) -> JByteArray<'a> {
    env.with_env(|env| -> Result<_, JniError> {
        let p = pose(env, &p)?;
        // SAFETY: a live handle on its thread.
        let r = unsafe { crate::run(stage(s), |st| st.export_png(width.max(0) as u32, height.max(0) as u32, p)) };
        bytes(env, r)
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// Straight-alpha RGBA rows, top first.
#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_snapshot<'a>(
    mut env: EnvUnowned<'a>,
    _class: JClass<'a>,
    s: jlong,
    width: jint,
    height: jint,
    p: JDoubleArray<'a>,
) -> JByteArray<'a> {
    env.with_env(|env| -> Result<_, JniError> {
        let p = pose(env, &p)?;
        // SAFETY: a live handle on its thread.
        let r = unsafe { crate::run(stage(s), |st| st.snapshot(width.max(0) as u32, height.max(0) as u32, p)) };
        bytes(env, r)
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// `format`: 0 GLB, 1 USDZ.
#[no_mangle]
pub extern "system" fn Java_com_card3d_Native_exportAr<'a>(
    mut env: EnvUnowned<'a>,
    _class: JClass<'a>,
    s: jlong,
    format: jint,
    size: jint,
    upright: jboolean,
) -> JByteArray<'a> {
    env.with_env(|env| -> Result<_, JniError> {
        if !(0..=1).contains(&format) {
            return throw(env, (Card3dStatus::InvalidArgument, "format: 0 GLB or 1 USDZ".into()));
        }
        // SAFETY: a live handle on its thread.
        let r = unsafe { crate::run(stage(s), |st| st.export_ar(format == 1, size.max(0) as u32, upright)) };
        bytes(env, r)
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

// The rest take and return numbers only: straight through to the C ABI (which ignores a stopped or
// missing stage, as Kotlin's `Engine` never passes one).

/// `Java_com_card3d_Native_<name>(stage, args…)` → `card3d_stage_<…>(stage, args…)`.
macro_rules! forward {
    ($($java:ident => $c:ident($($arg:ident: $ty:ident),*) $(-> $ret:ident)?;)*) => {$(
        #[no_mangle]
        #[allow(trivial_numeric_casts, reason = "the result's cast is a no-op for some of the C functions")]
        pub extern "system" fn $java(_env: EnvUnowned<'_>, _class: JClass<'_>, s: jlong $(, $arg: $ty)*) $(-> $ret)? {
            // SAFETY: a live handle on its thread; the arguments are plain values.
            unsafe { crate::$c(stage(s) $(, forward!(@arg $arg: $ty))*) $(as $ret)? }
        }
    )*};
    (@arg $arg:ident: jint) => { $arg as _ };
    (@arg $arg:ident: $ty:ident) => { $arg };
}

forward! {
    Java_com_card3d_Native_resize => card3d_stage_resize(width: jint, height: jint);
    Java_com_card3d_Native_setFit => card3d_stage_set_fit(fit: jint);
    Java_com_card3d_Native_setReducedMotion => card3d_stage_set_reduced_motion(reduced: jboolean);
    Java_com_card3d_Native_setVisible => card3d_stage_set_visible(visible: jboolean);
    Java_com_card3d_Native_setRotation => card3d_stage_set_rotation(x: jdouble, y: jdouble, z: jdouble);
    Java_com_card3d_Native_setCameraOrbit => card3d_stage_set_camera_orbit(azimuth: jdouble, elevation: jdouble, distance: jdouble);
    Java_com_card3d_Native_pointerDown => card3d_stage_pointer_down(id: jint, x: jdouble, y: jdouble, width: jdouble, height: jdouble, now: jdouble) -> jboolean;
    Java_com_card3d_Native_pointerMove => card3d_stage_pointer_move(id: jint, x: jdouble, y: jdouble, now: jdouble) -> jboolean;
    Java_com_card3d_Native_pointerUp => card3d_stage_pointer_up(id: jint, x: jdouble, y: jdouble, now: jdouble);
    Java_com_card3d_Native_pointerCancel => card3d_stage_pointer_cancel(id: jint);
    Java_com_card3d_Native_setPointer => card3d_stage_set_pointer(inside: jboolean, x: jdouble, y: jdouble);
    Java_com_card3d_Native_wheel => card3d_stage_wheel(delta: jdouble);
    Java_com_card3d_Native_doubleClick => card3d_stage_double_click();
    Java_com_card3d_Native_key => card3d_stage_key(key: jint, now: jdouble) -> jboolean;
    Java_com_card3d_Native_toggleFlip => card3d_stage_toggle_flip(now: jdouble);
    Java_com_card3d_Native_setFlipped => card3d_stage_set_flipped(flipped: jboolean, now: jdouble);
    Java_com_card3d_Native_reset => card3d_stage_reset();
    Java_com_card3d_Native_flipped => card3d_stage_flipped() -> jboolean;
}
