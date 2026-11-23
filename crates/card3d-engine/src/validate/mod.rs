//! Design validation for native hosts (feature `validate`): the TypeScript's `ensureDesign` and
//! `lintDesign` (packages/core/src/design/, src/describe/lint.ts) in Rust, with the same results. A
//! native host runs untrusted designs (share links, files, a model's output) through [`ensure`] before
//! handing the JSON to the engine, exactly as the web page runs them through `ensureDesign`.
//!
//! The results are pinned to the TypeScript: `node crates/card3d-tools/validate-compare.ts` runs both
//! over every fixture, every preset and thousands of mutated designs and requires identical design
//! JSON and issue lists; tests/validate.rs checks a committed sample of those cases. The catalogs (ids,
//! parameter tables, ranges, field lists) come from the TypeScript too (catalog.json, written by
//! `node crates/card3d-tools/validate-catalog.ts`).
//!
//! Where JavaScript's strings and Rust's differ: a lone UTF-16 surrogate (a `\ud800` escape, or a
//! 48-unit text line ending inside an emoji) becomes U+FFFD, as `String.prototype.toWellFormed` does.
//! Objects nest at most `js::MAX_DEPTH` levels. Sticker ids made up for stickers without one use their
//! own random suffix, as `Math.random` does in the TypeScript.

mod catalog;
pub mod custom_parse;
pub mod js;
mod lint;
mod sanitize;

pub use js::JsValue;
pub use lint::Lint;
pub use sanitize::{MAX_CUSTOM_CODE, MAX_SHADER_LAYERS};

/// One finding: where (`recipe.texture`, `shaders[0].code:12`, "" for the whole document) and what.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub path: String,
    pub message: String,
}

/// A validated design.
#[derive(Clone, Debug, PartialEq)]
pub struct Ensured {
    /// The complete `CardDesign` as JSON (`JSON.stringify(ensureDesign(input))`): what to hand the
    /// engine (`CardDesign::from_json`).
    pub design: String,
    /// What makes the design not what was written (unknown fields or ids, values of the wrong kind).
    /// The design is still usable: the sanitizer dropped or replaced those parts.
    pub errors: Vec<Issue>,
    /// Clamped values and likely mistakes.
    pub warnings: Vec<Issue>,
}

/// Validates and completes a design given as JSON text: `ensureDesign` plus `lintDesign`'s report.
/// `Err` when there is no design to draw (not JSON, not an object, nothing recognisable): the issue
/// says why.
pub fn ensure(json: &str) -> Result<Ensured, Issue> {
    let l = lint::lint(json);
    match l.design {
        Some(d) => Ok(Ensured { design: js::stringify(&d), errors: l.errors, warnings: l.warnings }),
        None => Err(l.errors.into_iter().next().unwrap_or(Issue { path: String::new(), message: "no design".into() })),
    }
}

/// `ensureDesign(input)` on a parsed value: the complete design, or the TypeScript's error message.
pub fn ensure_design(input: &JsValue) -> Result<JsValue, String> {
    sanitize::ensure_design(input)
}

/// `lintDesign(json)`: the design as it will load (`None` when nothing could be read) with the errors
/// and warnings.
pub fn lint(json: &str) -> Lint {
    lint::lint(json)
}

/// The parameters a custom face layer declares, with the annotation errors (`parseCustomShader`).
pub fn parse_custom_shader(code: &str, wgsl: bool) -> custom_parse::Parse {
    custom_parse::parse(code, wgsl)
}
