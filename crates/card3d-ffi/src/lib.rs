//! The card engine behind a small C ABI, for native apps: the Swift package (apple/) links it as a
//! static library; an Android library can load it as a shared one. `include/card3d.h` is generated
//! from this file by cbindgen (apple/build-xcframework.sh regenerates and checks it).
//!
//! The contract, also stated in the header:
//! - **Strings in** are NUL-terminated UTF-8, borrowed for the call.
//! - **Strings out** (`char **` parameters) are allocated here and freed by the caller with
//!   `card3d_string_free`; a NULL out-pointer means "don't want it". **Byte buffers out**
//!   (`Card3dBytes`) are freed with `card3d_bytes_free`.
//! - **A stage** is created by `card3d_stage_new`, freed by `card3d_stage_free`, and used only from
//!   the thread that created it (the main thread on Apple platforms). It must not outlive its
//!   `CAMetalLayer`; an `ANativeWindow` it holds a reference to itself.
//! - **Failures** come back as a `Card3dStatus` with a message. A panic inside the engine is caught
//!   at this boundary: the call returns `CARD3D_STATUS_PANIC` and the stage refuses further work
//!   (free it and make a new one). So does a GPU failure (`CARD3D_STATUS_GPU`).
//!
//! No wgpu type crosses the boundary: the surface is a `CAMetalLayer` or `ANativeWindow` pointer, the
//! rest numbers, strings and bytes. On Android, `android.rs` adds the Kotlin library's JNI methods
//! (`com.card3d.Native`) over the same functions.

// This crate is the boundary: `#[no_mangle]` exports over raw pointers, JNI, and wgpu surfaces made
// from the app's window handles. Every unsafe block states why it is sound, every unsafe fn its
// contract (`# Safety`).
#![allow(unsafe_code, reason = "the C ABI and JNI: raw pointers and exported symbols")]
// A panic here marks the stage broken; a `Card3dStatus` with a message is the better answer.
#![warn(clippy::unwrap_used)]

#[cfg(target_os = "android")]
mod android;
pub mod host;
pub mod stage;

use stage::{Error, NativeStage, Options, Target};
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// The version of this ABI: bumped on any incompatible change to the header.
pub const CARD3D_ABI_VERSION: u32 = 1;

/// What a call returns.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Card3dStatus {
    Ok = 0,
    /// A NULL pointer, a string that isn't UTF-8, a value out of range, or no card yet.
    InvalidArgument = 1,
    /// The design (or the assets JSON) couldn't be read: nothing to draw.
    Design = 2,
    /// No GPU, the surface, a lost device or a GPU error: the stage stops; make a new one.
    Gpu = 3,
    /// An export couldn't be made.
    Export = 4,
    /// The engine panicked: the stage stops; make a new one.
    Panic = 5,
}

/// What a stage draws into (`Card3dSurface.kind`).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Card3dSurfaceKind {
    /// No surface: an offscreen texture (tests, exports). `handle` is ignored.
    Offscreen = 0,
    /// `handle` is a `CAMetalLayer *` (iOS, macOS).
    MetalLayer = 1,
    /// `handle` is an `ANativeWindow *` (Android). The stage takes its own reference to the window
    /// (`ANativeWindow_acquire`) and releases it when freed.
    AndroidWindow = 2,
}

/// The surface, with its drawable size in device pixels.
#[repr(C)]
pub struct Card3dSurface {
    /// A `Card3dSurfaceKind`.
    pub kind: u32,
    pub handle: *mut c_void,
    pub width: u32,
    pub height: u32,
}

/// Stage options (the web stage's `createEngineStage` options).
#[repr(C)]
pub struct Card3dStageOptions {
    /// 0 performance (phones, the default), 1 full.
    pub quality: u32,
    /// 0 studio (fixed camera), 1 contain (the card fills the view with a margin).
    pub fit: u32,
    /// Drag to turn, tap to flip, double tap to reset, keys.
    pub interactive: bool,
    /// The one-shot intro on the first card (pass false when the user prefers reduced motion).
    pub intro: bool,
    pub reduced_motion: bool,
    pub fit_to_viewport: bool,
    /// The resting rotation, degrees (pitch, yaw).
    pub rotation_x: f64,
    pub rotation_y: f64,
    /// The directory of the bundled scene environments (`<id>.webp`); NULL: scenes light with the
    /// studio environment.
    pub environments_dir: *const c_char,
}

/// A byte buffer the library allocated; free it with `card3d_bytes_free`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Card3dBytes {
    pub data: *mut u8,
    pub len: usize,
}

/// A stage: the card, its GPU and its surface. Opaque.
pub struct Card3dStage {
    inner: Box<NativeStage>,
    /// Set by a panic or a GPU failure: further calls are refused.
    broken: Option<Card3dStatus>,
}

/// `card3d_stage_advance` flag: something animates; render every frame while it is set.
pub const CARD3D_ANIMATING: u32 = 1;
/// `card3d_stage_advance` flag: the interaction's rotation changed (a drag frame, a reset).
pub const CARD3D_ROTATION_CHANGED: u32 = 2;
/// `card3d_stage_advance` flag: the card turned to the other side.
pub const CARD3D_FLIPPED_CHANGED: u32 = 4;

// ── helpers ──────────────────────────────────────────────────────────────────

fn status(e: &Error) -> Card3dStatus {
    match e {
        Error::Design(_) => Card3dStatus::Design,
        Error::Gpu(_) => Card3dStatus::Gpu,
        Error::Export(_) => Card3dStatus::Export,
        Error::State(_) => Card3dStatus::InvalidArgument,
    }
}

/// Writes `s` to `out` (when not NULL) as a string the caller frees.
unsafe fn put(out: *mut *mut c_char, s: &str) {
    if !out.is_null() {
        let c = CString::new(s.replace('\0', "\u{FFFD}")).unwrap_or_default();
        *out = c.into_raw();
    }
}

unsafe fn clear(out: *mut *mut c_char) {
    if !out.is_null() {
        *out = std::ptr::null_mut();
    }
}

/// A borrowed string argument (NULL: `None`).
unsafe fn arg<'a>(s: *const c_char) -> Result<Option<&'a str>, Error> {
    if s.is_null() {
        return Ok(None);
    }
    CStr::from_ptr(s).to_str().map(Some).map_err(|_| Error::State("a string argument isn't UTF-8".into()))
}

fn panic_message(p: Box<dyn std::any::Any + Send>) -> String {
    let m = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
    format!("the card engine panicked: {m}")
}

/// Runs `f` on the stage, catching a panic; a GPU failure or panic marks the stage broken. The error
/// is the status and its message.
pub(crate) unsafe fn run<T>(stage: *mut Card3dStage, f: impl FnOnce(&mut NativeStage) -> Result<T, Error>) -> Result<T, (Card3dStatus, String)> {
    let Some(s) = stage.as_mut() else {
        return Err((Card3dStatus::InvalidArgument, "no stage".into()));
    };
    if let Some(b) = s.broken {
        return Err((b, "the stage stopped after a GPU failure or a panic; make a new one".into()));
    }
    match catch_unwind(AssertUnwindSafe(|| f(&mut s.inner))) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => {
            let st = status(&e);
            if st == Card3dStatus::Gpu {
                s.broken = Some(st);
            }
            Err((st, e.to_string()))
        }
        Err(p) => {
            s.broken = Some(Card3dStatus::Panic);
            Err((Card3dStatus::Panic, panic_message(p)))
        }
    }
}

/// `run`, with the message written to `error`.
unsafe fn with_stage<T>(stage: *mut Card3dStage, error: *mut *mut c_char, f: impl FnOnce(&mut NativeStage) -> Result<T, Error>) -> Result<T, Card3dStatus> {
    clear(error);
    run(stage, f).map_err(|(st, m)| {
        put(error, &m);
        st
    })
}

/// For calls without an error channel: runs `f`, `default` when the stage is missing, broken, or panics.
unsafe fn quiet<T>(stage: *mut Card3dStage, default: T, f: impl FnOnce(&mut NativeStage) -> T) -> T {
    let mut r = Some(default);
    let _ = with_stage(stage, std::ptr::null_mut(), |s| {
        r = Some(f(s));
        Ok(())
    });
    r.expect("result")
}

fn code<T>(r: Result<T, Card3dStatus>) -> Card3dStatus {
    r.map_or_else(|e| e, |_| Card3dStatus::Ok)
}

unsafe fn put_bytes(out: *mut Card3dBytes, bytes: Vec<u8>) {
    if !out.is_null() {
        let b = bytes.into_boxed_slice();
        let len = b.len();
        *out = Card3dBytes { data: Box::into_raw(b).cast::<u8>(), len };
    }
}

// ── library ──────────────────────────────────────────────────────────────────

/// `CARD3D_ABI_VERSION` of the linked library (check it against the header's).
#[no_mangle]
pub extern "C" fn card3d_abi_version() -> u32 {
    CARD3D_ABI_VERSION
}

/// Frees a string the library returned. NULL is fine.
///
/// # Safety
/// `s` is NULL or a string from this library, freed once.
#[no_mangle]
pub unsafe extern "C" fn card3d_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

/// Frees a buffer the library returned. An empty one is fine.
///
/// # Safety
/// `bytes` came from this library, freed once.
#[no_mangle]
pub unsafe extern "C" fn card3d_bytes_free(bytes: Card3dBytes) {
    if !bytes.data.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(bytes.data, bytes.len)));
    }
}

/// Validates a design (`ensureDesign` and `lintDesign`, as the web validates it) without a GPU; any
/// thread. On `CARD3D_STATUS_OK`, `report` receives JSON:
/// `{ "design": {…complete design…}, "errors": [{ "path", "message" }], "warnings": […],
///    "remote": ["https://…", …], "shaderErrors": [] }`.
/// `remote` lists the design's http(s) URLs: download them and pass their local paths in
/// `card3d_stage_set_design`'s assets (`files`). On `CARD3D_STATUS_DESIGN` (nothing to draw), `error`
/// says why.
///
/// # Safety
/// `json` is a NUL-terminated string; `report` and `error` are NULL or writable.
#[no_mangle]
pub unsafe extern "C" fn card3d_validate(json: *const c_char, report: *mut *mut c_char, error: *mut *mut c_char) -> Card3dStatus {
    clear(report);
    clear(error);
    let r = match arg(json) {
        Ok(Some(json)) => validate_report(json),
        Ok(None) => Err((Card3dStatus::InvalidArgument, "no design".into())),
        Err(e) => Err((status(&e), e.to_string())),
    };
    match r {
        Ok(rep) => {
            put(report, &rep);
            Card3dStatus::Ok
        }
        Err((st, m)) => {
            put(error, &m);
            st
        }
    }
}

/// `card3d_validate`'s report (JSON), panics caught.
pub(crate) fn validate_report(json: &str) -> Result<String, (Card3dStatus, String)> {
    match catch_unwind(|| stage::validate(json)) {
        Ok(Ok(rep)) => Ok(rep.to_json(true)),
        Ok(Err(e)) => Err((status(&e), e.to_string())),
        Err(p) => Err((Card3dStatus::Panic, panic_message(p))),
    }
}

// ── stage ────────────────────────────────────────────────────────────────────

/// Starts the GPU on `surface` and makes an empty stage (nothing is drawn until a design is set).
///
/// # Safety
/// `options`, `surface` and `out` are valid pointers; a `CAMetalLayer` handle stays alive while the
/// stage does (an `ANativeWindow` is retained by the stage); `error` is NULL or writable.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_new(
    options: *const Card3dStageOptions,
    surface: *const Card3dSurface,
    out: *mut *mut Card3dStage,
    error: *mut *mut c_char,
) -> Card3dStatus {
    clear(error);
    if out.is_null() || options.is_null() || surface.is_null() {
        put(error, "NULL argument");
        return Card3dStatus::InvalidArgument;
    }
    *out = std::ptr::null_mut();
    match new_stage(&*options, &*surface) {
        Ok(stage) => {
            *out = stage;
            Card3dStatus::Ok
        }
        Err((st, m)) => {
            put(error, &m);
            st
        }
    }
}

/// `card3d_stage_new`: the stage, or the status and its message.
pub(crate) unsafe fn new_stage(o: &Card3dStageOptions, s: &Card3dSurface) -> Result<*mut Card3dStage, (Card3dStatus, String)> {
    let r = catch_unwind(AssertUnwindSafe(|| -> Result<Box<NativeStage>, Error> {
        let interactive = o.interactive;
        let stage = card3d_engine::stage::StageOptions {
            quality: stage::quality(o.quality).ok_or_else(|| Error::State("quality: 0 or 1".into()))?,
            fit: stage::fit(o.fit).ok_or_else(|| Error::State("fit: 0 or 1".into()))?,
            interactive,
            intro: o.intro && interactive,
            reduced_motion: o.reduced_motion,
            fit_to_viewport: o.fit_to_viewport,
            default_rotation: card3d_engine::interaction::CardRotation { x: o.rotation_x, y: o.rotation_y },
        };
        let environments = arg(o.environments_dir)?.filter(|d| !d.is_empty()).map(std::path::PathBuf::from);
        let target = match s.kind {
            k if k == Card3dSurfaceKind::Offscreen as u32 => Target::Offscreen,
            #[cfg(target_vendor = "apple")]
            k if k == Card3dSurfaceKind::MetalLayer as u32 => Target::MetalLayer(s.handle),
            #[cfg(target_os = "android")]
            k if k == Card3dSurfaceKind::AndroidWindow as u32 => Target::AndroidWindow(s.handle),
            _ => return Err(Error::State("this surface kind isn't supported on this platform".into())),
        };
        NativeStage::new(Options { stage, environments }, target, s.width, s.height)
    }));
    match r {
        Ok(Ok(inner)) => Ok(Box::into_raw(Box::new(Card3dStage { inner, broken: None }))),
        Ok(Err(e)) => Err((status(&e), e.to_string())),
        Err(p) => Err((Card3dStatus::Panic, panic_message(p))),
    }
}

/// Frees a stage, its card and its GPU objects. NULL is fine.
///
/// # Safety
/// `stage` is NULL or from `card3d_stage_new`, freed once, on its thread.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_free(stage: *mut Card3dStage) {
    if !stage.is_null() {
        let s = Box::from_raw(stage);
        let _ = catch_unwind(AssertUnwindSafe(move || drop(s)));
    }
}

/// Validates the design (as `card3d_validate`), builds its card and shows it; the card's pose stays.
/// `assets`: JSON or NULL, `{ "files": { "<url>": "<local path>" }, "base": "<dir for relative
/// srcs>", "nameFontFamily": "…" }` (the engine reads data URLs and files only; URLs not in `files`
/// are skipped like a failed image on the web). On success `report` receives `{ "errors", "warnings", "remote", "shaderErrors" }` (as
/// `card3d_validate`'s, without the design; `shaderErrors`: face shader layers that didn't compile).
/// Animated GIF stickers decode on a worker thread and start playing on a later `advance`.
///
/// # Safety
/// `stage` is a live stage; strings NUL-terminated; out-pointers NULL or writable.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_design(
    stage: *mut Card3dStage,
    json: *const c_char,
    assets: *const c_char,
    report: *mut *mut c_char,
    error: *mut *mut c_char,
) -> Card3dStatus {
    clear(report);
    let r = with_stage(stage, error, |s| {
        let json = arg(json)?.ok_or_else(|| Error::State("no design".into()))?;
        s.set_design(json, arg(assets)?.unwrap_or(""))
    });
    if let Ok(rep) = &r {
        put(report, &rep.to_json(false));
    }
    code(r)
}

/// The drawable size changed (device pixels: the view's size × its scale).
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_resize(stage: *mut Card3dStage, width: u32, height: u32) {
    quiet(stage, (), |s| s.resize(width, height))
}

/// Advances the interaction, the card's animations and its GIF stickers to `now_ms` (a monotonic
/// clock, ms). Returns `CARD3D_ANIMATING` (render every frame while set), `CARD3D_ROTATION_CHANGED`,
/// `CARD3D_FLIPPED_CHANGED`. `wake_ms` (NULL or writable) receives the ms after which something
/// changes although nothing animates (a GIF's next frame), or a negative number for "nothing
/// scheduled": a host renders only while animating or when woken, and after input.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_advance(stage: *mut Card3dStage, now_ms: f64, wake_ms: *mut f64) -> u32 {
    let (flags, wake) = quiet(stage, (0, None), |s| s.advance(now_ms));
    if !wake_ms.is_null() {
        *wake_ms = wake.unwrap_or(-1.0);
    }
    flags
}

/// Draws the current state and presents it (or into the offscreen texture).
///
/// # Safety
/// `stage` is a live stage; `error` NULL or writable.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_render(stage: *mut Card3dStage, error: *mut *mut c_char) -> Card3dStatus {
    code(with_stage(stage, error, |s| s.render()))
}

/// The rendering tier (0 performance, 1 full); rebuilds the card.
///
/// # Safety
/// `stage` is a live stage; `error` NULL or writable.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_quality(stage: *mut Card3dStage, quality: u32, error: *mut *mut c_char) -> Card3dStatus {
    code(with_stage(stage, error, |s| s.set_quality(stage::quality(quality).ok_or_else(|| Error::State("quality: 0 or 1".into()))?)))
}

/// The framing (0 studio, 1 contain), from the next frame.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_fit(stage: *mut Card3dStage, fit: u32) {
    quiet(stage, (), |s| {
        if let Some(f) = stage::fit(fit) {
            s.set_fit(f)
        }
    })
}

/// A lighting preset id ("studio", "warm", …) in place of the design's own, or NULL / "" for the
/// design's; rebuilds the card.
///
/// # Safety
/// `stage` is a live stage; `id` NULL or NUL-terminated; `error` NULL or writable.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_lighting(stage: *mut Card3dStage, id: *const c_char, error: *mut *mut c_char) -> Card3dStatus {
    code(with_stage(stage, error, |s| s.set_lighting(arg(id)?)))
}

/// The user's reduced-motion preference changed.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_reduced_motion(stage: *mut Card3dStage, reduced: bool) {
    quiet(stage, (), |s| s.set_reduced_motion(reduced))
}

/// The app went to the background (false) or came back (true): hiding ends a drag and finishes a
/// running intro or flip.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_visible(stage: *mut Card3dStage, visible: bool) {
    quiet(stage, (), |s| s.set_visible(visible))
}

/// The slot's rotation (radians, Euler XYZ), independent of the interaction.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_rotation(stage: *mut Card3dStage, x: f64, y: f64, z: f64) {
    quiet(stage, (), |s| s.set_rotation([x, y, z]))
}

/// Orbits the camera around the card: azimuth and extra elevation (degrees) and × the distance;
/// (0, 0, 1) returns to the plain camera.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_camera_orbit(stage: *mut Card3dStage, azimuth: f64, elevation: f64, distance: f64) {
    quiet(stage, (), |s| s.set_camera_orbit([azimuth, elevation, distance].iter().all(|v| v.is_finite()).then_some([azimuth, elevation, distance])))
}

/// A touch or the mouse went down at (`x`, `y`) points from the view's top left, in a view
/// `width` × `height` points, at `now_ms`. True: the card took it (track it until up or cancel).
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_pointer_down(stage: *mut Card3dStage, id: i32, x: f64, y: f64, width: f64, height: f64, now_ms: f64) -> bool {
    quiet(stage, false, |s| s.pointer_down(id, x, y, width, height, now_ms))
}

/// True: the move belongs to a drag (render).
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_pointer_move(stage: *mut Card3dStage, id: i32, x: f64, y: f64, now_ms: f64) -> bool {
    quiet(stage, false, |s| s.pointer_move(id, x, y, now_ms))
}

/// Ends a drag; a quick press that didn't move (a tap or click) flips the card.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_pointer_up(stage: *mut Card3dStage, id: i32, x: f64, y: f64, now_ms: f64) {
    quiet(stage, (), |s| s.pointer_up(id, x, y, now_ms))
}

/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_pointer_cancel(stage: *mut Card3dStage, id: i32) {
    quiet(stage, (), |s| s.pointer_cancel(id))
}

/// Where the pointer is over the view, normalised (x right, y up, −1…1; beyond outside the view), for
/// effects that follow it (live liquid metal, which keeps drawing by itself); `inside` false: it left.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_pointer(stage: *mut Card3dStage, inside: bool, x: f64, y: f64) {
    quiet(stage, (), |s| s.set_pointer((inside && x.is_finite() && y.is_finite()).then_some([x, y])))
}

/// A scroll (points; the larger axis), for effects that react to it.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_wheel(stage: *mut Card3dStage, delta: f64) {
    quiet(stage, (), |s| s.wheel(delta))
}

/// A double click or double tap: resets the card.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_double_click(stage: *mut Card3dStage) {
    quiet(stage, (), |s| s.double_click())
}

/// A key: 1 reset (Home / Escape), 2 flip (Enter / Space). True: handled.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_key(stage: *mut Card3dStage, key: u32, now_ms: f64) -> bool {
    quiet(stage, false, |s| matches!(key, 1 | 2) && s.key(key == 1, now_ms))
}

/// Flips the card (animated), or to a side.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_toggle_flip(stage: *mut Card3dStage, now_ms: f64) {
    quiet(stage, (), |s| s.toggle_flip(now_ms))
}

/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_set_flipped(stage: *mut Card3dStage, flipped: bool, now_ms: f64) {
    quiet(stage, (), |s| s.set_flipped(flipped, now_ms))
}

/// Back to the resting pose, front up.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_reset(stage: *mut Card3dStage) {
    quiet(stage, (), |s| s.reset())
}

/// Whether the back faces the viewer.
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_flipped(stage: *mut Card3dStage) -> bool {
    quiet(stage, false, |s| s.flipped())
}

/// The interaction's pitch and yaw (degrees) into `x`, `y` (NULL or writable).
///
/// # Safety
/// `stage` is a live stage or NULL.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_rotation(stage: *mut Card3dStage, x: *mut f64, y: *mut f64) {
    let (rx, ry) = quiet(stage, (0.0, 0.0), |s| s.rotation());
    if !x.is_null() {
        *x = rx;
    }
    if !y.is_null() {
        *y = ry;
    }
}

/// A PNG of the card, `width` × `height` px, transparent around it. `pose`: NULL for the card as it
/// is on screen, else 3 doubles: the slot's Euler rotation (radians, XYZ) with the interaction's
/// pose left out (the harness's parity poses). `out` receives the file (free with `card3d_bytes_free`).
///
/// # Safety
/// `stage` is a live stage; `pose` NULL or 3 doubles; `out` writable; `error` NULL or writable.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_export_png(
    stage: *mut Card3dStage,
    width: u32,
    height: u32,
    pose: *const f64,
    out: *mut Card3dBytes,
    error: *mut *mut c_char,
) -> Card3dStatus {
    let pose = (!pose.is_null()).then(|| [*pose, *pose.add(1), *pose.add(2)]);
    let r = with_stage(stage, error, |s| s.export_png(width, height, pose));
    if let Ok(bytes) = r {
        put_bytes(out, bytes);
        return Card3dStatus::Ok;
    }
    code(r)
}

/// Like `card3d_stage_export_png`, but the raw pixels: straight-alpha RGBA, rows top first,
/// `4 × width × height` bytes.
///
/// # Safety
/// As `card3d_stage_export_png`.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_snapshot(
    stage: *mut Card3dStage,
    width: u32,
    height: u32,
    pose: *const f64,
    out: *mut Card3dBytes,
    error: *mut *mut c_char,
) -> Card3dStatus {
    let pose = (!pose.is_null()).then(|| [*pose, *pose.add(1), *pose.add(2)]);
    let r = with_stage(stage, error, |s| s.snapshot(width, height, pose));
    if let Ok(px) = r {
        put_bytes(out, px);
        return Card3dStatus::Ok;
    }
    code(r)
}

/// The card's AR model: `format` 0 GLB, 1 USDZ (AR Quick Look); its baked maps `size` px on their
/// longer side (0: 2048); lying face up, or `upright`. `out` receives the file.
///
/// # Safety
/// `stage` is a live stage; `out` writable; `error` NULL or writable.
#[no_mangle]
pub unsafe extern "C" fn card3d_stage_export_ar(
    stage: *mut Card3dStage,
    format: u32,
    size: u32,
    upright: bool,
    out: *mut Card3dBytes,
    error: *mut *mut c_char,
) -> Card3dStatus {
    let r = with_stage(stage, error, |s| {
        if format > 1 {
            return Err(Error::State("format: 0 GLB or 1 USDZ".into()));
        }
        s.export_ar(format == 1, size, upright)
    });
    if let Ok(bytes) = r {
        put_bytes(out, bytes);
        return Card3dStatus::Ok;
    }
    code(r)
}
