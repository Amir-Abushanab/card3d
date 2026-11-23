//! The card engine: draws a `CardDesign` with wgpu. Platform specifics
//! (2D canvases for textures and text, later images) come from the host (`canvas::Host`), so the
//! same code runs in the browser (card3d-web) and natively (card3d-native).
//!
//! The engine was ported from the three.js engine and pinned to it. The TypeScript modules the
//! comments name as sources (`scene/stage.ts`, `card/branding.ts`, `addons/vines/`…) are that engine's,
//! which since phase 9 lives in a local, gitignored archive at the same paths under
//! `.archive/three-engine/packages/core/src/` (crates/card3d-tools/three-archive.mjs runs it); the
//! three-free ones (the design model, `engine.ts`, `marquee/mount.ts`, `effects/params.ts`, `fonts.ts`…)
//! are still in packages/core/src.
#![allow(
    clippy::missing_const_for_thread_local,
    reason = "every thread_local! here has a const initializer; clippy still flags them for aarch64-linux-android"
)]

/// A shader under shaders/, minified by build.rs.
macro_rules! wgsl {
    ($path:literal) => {
        include_str!(concat!(env!("OUT_DIR"), "/shaders/", $path))
    };
}

pub mod adaptive;
pub mod ar;
pub mod ar_formats;
pub mod artwork;
pub mod branding;
pub mod canvas;
pub mod card;
pub mod chip;
pub mod chip_module;
pub mod decals;
pub mod design;
pub mod edge;
pub mod effect_params;
pub mod effects;
pub mod env;
pub mod extrude;
pub mod face_custom;
pub mod face_library;
pub mod face_shaders;
pub mod finish;
pub mod fonts;
pub mod geometry;
pub mod glass;
pub mod glass_geometry;
pub mod holo;
pub mod interaction;
pub mod iso;
pub mod json;

/// What a split point (`#[wasm_split(name, fallible)]`) returns when its wasm chunk couldn't be
/// downloaded; callers turn it into a [`LoadError`] naming the chunk. Natively it never happens.
#[derive(Debug)]
pub struct ChunkUnavailable;

impl From<wasm_split_helpers::SplitLoaderError> for ChunkUnavailable {
    fn from(_: wasm_split_helpers::SplitLoaderError) -> Self {
        ChunkUnavailable
    }
}

/// The card couldn't be built because a lazily loaded part of the engine (the wasm chunk `chunk`)
/// couldn't be downloaded: a network problem, not a GPU one. Building again retries the download.
#[derive(Clone, Debug, PartialEq)]
pub struct LoadError {
    pub chunk: &'static str,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "couldn't download the card engine's {} part", self.chunk)
    }
}

impl std::error::Error for LoadError {}

/// `ChunkUnavailable` → `LoadError` for chunk `name`.
pub(crate) fn chunk(name: &'static str) -> impl Fn(ChunkUnavailable) -> LoadError {
    move |_| LoadError { chunk: name }
}
pub mod layout;
pub mod lighting;
pub mod liquid_metal;
pub mod mark;
pub mod marquee;
pub mod marquee_model;
pub mod material;
pub mod print;
pub mod quality;
pub mod renderer;
pub mod scene;
pub mod shape;
pub mod shine;
pub mod stage;
pub mod text;
#[cfg(feature = "validate")]
pub mod validate;
pub mod vines;
pub mod vines_model;

pub use canvas::{Canvas, Host};
pub use card::{CardOptions, CardRenderer};
pub use design::CardDesign;
