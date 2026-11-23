//! `ensureDesign` and its sanitizers (packages/core/src/design/design.ts, sanitize.ts, decal.ts,
//! custom-font.ts and recipe/defaults.ts' `normalizeRecipe`), on JavaScript values, step for step.

use super::catalog::{self, ParamSpec};
use super::custom_parse::{self, ParamType};
use super::js::{clamp, is_word, is_ws, len16, round, slice16, string_to_number, trim, JsValue, Obj};

/// At most this many shader layers per card.
pub const MAX_SHADER_LAYERS: usize = 8;
/// At most this many characters (UTF-16 units) of custom code per layer.
pub const MAX_CUSTOM_CODE: usize = 20_000;
const MAX_LAYER_PARAMS: usize = 48;
const SIDES: [&str; 2] = ["front", "back"];
const OVERRIDE_RANGES: [(&str, f64, f64); 8] = [
    ("metalness", 0.0, 1.0),
    ("roughness", 0.0, 1.0),
    ("clearcoat", 0.0, 1.0),
    ("clearcoatRoughness", 0.0, 1.0),
    ("transmission", 0.0, 1.0),
    ("thickness", 0.0, 10.0),
    ("ior", 1.0, 2.5),
    ("brandingClearcoat", 0.0, 1.0),
];
pub(super) const LAYOUT_RANGES: [(&str, f64, f64); 2] = [("nameFontHeight", 0.02, 0.12), ("nameBottom", 0.02, 0.4)];
const MARK_FINISHES: [&str; 3] = ["embossed", "engraved", "etched"];
const CUTOUTS: [&str; 3] = ["lanyard", "notch", "window"];
const PLACEMENTS: [&str; 4] = ["bottom-left", "bottom-right", "center", "top"];
const ALIGNS: [&str; 3] = ["left", "center", "right"];
const BACKDROPS: [&str; 4] = ["none", "sweep", "gradient", "environment"];
/// `CUSTOM_FONT_WEIGHT`.
const FONT_WEIGHT: f64 = 700.0;
const FONT_FAMILY_CHARS: usize = 64;
const FONT_URL_CHARS: usize = 2048;
/// `Math.ceil(uploadBytes / 3) * 4 + 64` for 1 MiB.
const FONT_UPLOAD_CHARS: usize = 1_048_576_usize.div_ceil(3) * 4 + 64;

fn s(v: &str) -> JsValue {
    JsValue::Str(v.to_string())
}

fn n(v: f64) -> JsValue {
    JsValue::Num(v)
}

/// `Math.round(v * k) / k`.
fn round_to(v: f64, k: f64) -> f64 {
    round(v * k) / k
}

/// `/^#[0-9a-f]{6}$/i`.
pub(super) fn is_hex(v: &str) -> bool {
    v.len() == 7 && v.starts_with('#') && v[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn str_or(v: Option<&JsValue>, fallback: &str) -> String {
    v.and_then(JsValue::str).unwrap_or(fallback).to_string()
}

fn finite(v: Option<&JsValue>, fallback: f64) -> f64 {
    v.and_then(JsValue::num).unwrap_or(fallback)
}

fn some_obj(o: Obj) -> Option<JsValue> {
    (!o.is_empty()).then_some(JsValue::Obj(o))
}

/// A trimmed, lower-cased `#rrggbb` (`HEX.test(v.trim())`).
fn hex_trimmed(v: Option<&JsValue>) -> Option<String> {
    let t = trim(v?.str()?);
    is_hex(t).then(|| t.to_ascii_lowercase())
}

// ── ensureDesign ────────────────────────────────────────────────────────────────

/// `ensureDesign(input)`: a complete `CardDesign` from anything a user can paste or load, or the
/// TypeScript's error message.
pub(super) fn ensure_design(input: &JsValue) -> Result<JsValue, String> {
    let Some(inp) = input.obj() else { return Err("Expected a JSON object".into()) };
    let looks_like_recipe = ["material", "texture", "grain", "polish", "holoStyle", "frontHolo"].iter().any(|k| inp.has(k));
    let raw_recipe = match inp.get("recipe") {
        Some(JsValue::Obj(r)) => Some(r),
        _ if looks_like_recipe => Some(inp),
        _ => None,
    };
    let has_design_keys = ["cardholderName", "decals", "surfaceSources", "shaders", "addons"].iter().any(|k| inp.has(k));
    if raw_recipe.is_none() && !has_design_keys {
        return Err("No recipe or card design found in that JSON".into());
    }
    let cat = catalog::get();
    let get = |k: &str| inp.get(k);
    let mut d = Obj::new();
    d.set("recipe", normalize_recipe(raw_recipe.unwrap_or(&Obj::new())));
    let name = match get("cardholderName") {
        None | Some(JsValue::Null) => get("ownerName"),
        v => v,
    };
    d.set("cardholderName", s(&str_or(name, &cat.default_name)));
    d.set("cardholderBio", s(&str_or(get("cardholderBio"), "")));
    let decals = match get("decals") {
        Some(JsValue::Arr(a)) => a.iter().enumerate().filter_map(|(i, v)| to_decal(v, i)).collect(),
        _ => vec![],
    };
    d.set("decals", JsValue::Arr(decals));
    let mut sources = Obj::new();
    let mut treatments = Obj::new();
    for side in SIDES {
        if let Some(JsValue::Str(v)) = get("surfaceSources").and_then(|o| o.at(side)) {
            sources.set(side, s(v));
        }
        if let Some(t @ ("inlay" | "printed")) = get("surfaceTreatments").and_then(|o| o.at(side)).and_then(JsValue::str) {
            treatments.set(side, s(t));
        }
    }
    d.set("surfaceSources", JsValue::Obj(sources));
    d.set("surfaceTreatments", JsValue::Obj(treatments));
    let mut put = |k: &str, v: Option<JsValue>| {
        if let Some(v) = v {
            d.set(k, v);
        }
    };
    put("materialOverride", sanitize_override(get("materialOverride"), false));
    put("brandingOverride", sanitize_override(get("brandingOverride"), true));
    put("frontLayout", sanitize_layout(get("frontLayout")));
    put("addons", sanitize_addons(get("addons")));
    put("shaders", sanitize_shaders(get("shaders")));
    put("font", sanitize_font(get("font")));
    put("logo", sanitize_logo(get("logo")));
    put("lighting", get("lighting").and_then(JsValue::str).filter(|l| cat.lighting.iter().any(|x| x == l)).map(s));
    put("finish", sanitize_finish(get("finish")));
    put("edge", sanitize_edge(get("edge")));
    put("shape", sanitize_shape(get("shape")));
    put("contactless", sanitize_contactless(get("contactless")));
    put("textLines", sanitize_text_lines(get("textLines"), &cat.fonts));
    put("scene", sanitize_scene(get("scene")));
    Ok(JsValue::Obj(d))
}

/// `normalizeRecipe`: every field, from the input where it's the right kind of value, else the default.
fn normalize_recipe(r: &Obj) -> JsValue {
    let cat = catalog::get();
    let defaults = cat.default_recipe.obj().cloned().unwrap_or_default();
    let back_holo_keys =
        ["backHolo", "backHoloStyle", "backFoilTexture", "backFoilIntensity", "backHoloGlare", "backHoloMotion", "backFoilScale", "backFoilCoverage"];
    let mut out = Obj::new();
    for (k, default) in defaults.iter() {
        let v = r.get(k);
        let in_list = |list: &[String]| v.and_then(JsValue::str).is_some_and(|x| list.iter().any(|o| o == x));
        let in_strs = |list: &[&str]| v.and_then(JsValue::str).is_some_and(|x| list.contains(&x));
        let pick = |ok: bool| if ok { v.cloned().unwrap_or(JsValue::Null) } else { default.clone() };
        let value = match k {
            "material" => pick(in_list(&cat.materials)),
            "pattern" => pick(in_strs(&["none", "orbit"])),
            "texture" => pick(in_list(&cat.textures)),
            "color" => pick(v.and_then(JsValue::str).is_some_and(|c| !trim(c).is_empty())),
            "matchHoloSides" => match v {
                None | Some(JsValue::Null) => JsValue::Bool(!back_holo_keys.iter().any(|b| r.has(b))),
                Some(x) => JsValue::Bool(x.truthy()),
            },
            "frontHolo" | "backHolo" => match v {
                None | Some(JsValue::Null) => default.clone(),
                Some(x) => JsValue::Bool(x.truthy()),
            },
            "holoMotion" | "backHoloMotion" => JsValue::Bool(v != Some(&JsValue::Bool(false))),
            "holoStyle" | "backHoloStyle" => pick(in_list(&cat.holo_styles)),
            "foilTexture" | "backFoilTexture" => pick(in_list(&cat.foil_textures)),
            "foilCoverage" | "backFoilCoverage" => pick(in_strs(&["cover", "tile"])),
            _ => match default {
                JsValue::Num(_) => v.and_then(JsValue::num).map_or(default.clone(), JsValue::Num),
                _ => default.clone(),
            },
        };
        out.set(k, value);
    }
    JsValue::Obj(out)
}

/// `Math.random().toString(36).slice(2, 7)`: five base-36 characters.
fn random_suffix() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    let mut x = h.finish();
    (0..5)
        .map(|_| {
            let c = char::from_digit((x % 36) as u32, 36).unwrap_or('0');
            x /= 36;
            c
        })
        .collect()
}

fn to_decal(v: &JsValue, i: usize) -> Option<JsValue> {
    let o = v.obj()?;
    let src = o.get("src")?.str().filter(|s| !s.is_empty())?;
    let cat = catalog::get();
    let aspect = finite(o.get("aspect"), 1.0);
    let mut d = Obj::new();
    let id = str_or(o.get("id"), "");
    d.set("id", s(&if id.is_empty() { format!("sticker-{i}-{}", random_suffix()) } else { id }));
    d.set("side", s(if o.get("side").and_then(JsValue::str) == Some("back") { "back" } else { "front" }));
    d.set("src", s(src));
    d.set("aspect", n(if aspect > 0.0 { aspect.max(cat.decal_aspect.0).min(cat.decal_aspect.1) } else { 1.0 }));
    d.set("x", n(finite(o.get("x"), 50.0)));
    d.set("y", n(finite(o.get("y"), 50.0)));
    d.set("width", n(finite(o.get("width"), 22.0)));
    d.set("rotation", n(finite(o.get("rotation"), 0.0)));
    d.set("scale", n(finite(o.get("scale"), 1.0)));
    // `sanitizeDecalPicture`.
    let k4 = |x: f64| round_to(x, 1e4);
    let crop = o.get("crop").and_then(JsValue::obj).and_then(|c| {
        let (x, y, w, h) = (c.get("x")?.num()?, c.get("y")?.num()?, c.get("w")?.num()?, c.get("h")?.num()?);
        let m = cat.decal_min_crop;
        let w = k4(clamp(w, m, 1.0));
        let h = k4(clamp(h, m, 1.0));
        let x = k4(clamp(x, 0.0, 1.0 - w));
        let y = k4(clamp(y, 0.0, 1.0 - h));
        let full = x.abs() < 1e-4 && y.abs() < 1e-4 && (w - 1.0).abs() < 1e-4 && (h - 1.0).abs() < 1e-4;
        (!full).then(|| {
            let mut c = Obj::new();
            for (k, v) in [("x", x), ("y", y), ("w", w), ("h", h)] {
                c.set(k, n(v));
            }
            JsValue::Obj(c)
        })
    });
    if let Some(c) = crop {
        d.set("crop", c);
    }
    if let Some(f) = o.get("flip").and_then(JsValue::obj) {
        let (h, v) = (f.get("h") == Some(&JsValue::Bool(true)), f.get("v") == Some(&JsValue::Bool(true)));
        if h || v {
            let mut out = Obj::new();
            if h {
                out.set("h", JsValue::Bool(true));
            }
            if v {
                out.set("v", JsValue::Bool(true));
            }
            d.set("flip", JsValue::Obj(out));
        }
    }
    if let Some(t) = o.get("tint").and_then(JsValue::obj) {
        if let Some(color) = t.get("color").and_then(JsValue::str).filter(|c| is_hex(c)) {
            let amount = t.get("amount").and_then(JsValue::num).map_or(1.0, |a| round_to(clamp(a, 0.0, 1.0), 1e3));
            if amount > 0.0 {
                let mut out = Obj::new();
                out.set("color", s(&color.to_ascii_lowercase()));
                out.set("amount", n(amount));
                d.set("tint", JsValue::Obj(out));
            }
        }
    }
    if let Some(a) = o.get("adjust").and_then(JsValue::obj) {
        let mut out = Obj::new();
        for k in ["brightness", "contrast", "saturation"] {
            if let Some(x) = a.get(k).and_then(JsValue::num) {
                let c = round_to(clamp(x, -1.0, 1.0), 1e3);
                if c != 0.0 {
                    out.set(k, n(c));
                }
            }
        }
        if let Some(out) = some_obj(out) {
            d.set("adjust", out);
        }
    }
    if let Some(op) = o.get("opacity").and_then(JsValue::num).filter(|&op| op < 1.0) {
        d.set("opacity", n(round_to(clamp(op, 0.0, 1.0), 1e3)));
    }
    Some(JsValue::Obj(d))
}

fn sanitize_override(v: Option<&JsValue>, branding: bool) -> Option<JsValue> {
    let o = v?.obj()?;
    let mut out = Obj::new();
    if let Some(c) = hex_trimmed(o.get("color")) {
        out.set("color", s(&c));
    }
    for (k, a, b) in OVERRIDE_RANGES {
        if k == "brandingClearcoat" && !branding {
            continue;
        }
        if let Some(x) = o.get(k).and_then(JsValue::num) {
            out.set(k, n(clamp(x, a, b)));
        }
    }
    some_obj(out)
}

fn sanitize_layout(v: Option<&JsValue>) -> Option<JsValue> {
    let o = v?.obj()?;
    let mut out = Obj::new();
    for (k, a, b) in LAYOUT_RANGES {
        if let Some(x) = o.get(k).and_then(JsValue::num) {
            out.set(k, n(clamp(x, a, b)));
        }
    }
    some_obj(out)
}

/// `normalizeHexColor`: `#rrggbb` from `#?rrggbb` / `#?rgb`.
fn normalize_hex_color(v: &JsValue) -> Option<String> {
    let t = trim(v.str()?).to_lowercase();
    let h = t.strip_prefix('#').unwrap_or(&t);
    if !h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    match h.len() {
        6 => Some(format!("#{h}")),
        3 => Some(format!("#{}", h.chars().flat_map(|c| [c, c]).collect::<String>())),
        _ => None,
    }
}

/// `coerceEffectParam`.
pub(super) fn coerce_effect_param(spec: &ParamSpec, v: &JsValue) -> Option<JsValue> {
    match spec.ty.as_str() {
        "float" | "int" => {
            let mut x = v.num()?;
            if spec.ty == "int" {
                x = round(x);
            }
            if let Some(min) = spec.min {
                x = x.max(min);
            }
            if let Some(max) = spec.max {
                x = x.min(max);
            }
            Some(n(x))
        }
        "bool" => v.bool().map(JsValue::Bool),
        "color" => normalize_hex_color(v).map(JsValue::Str),
        "select" => v.str().filter(|x| spec.options.iter().any(|o| o.str() == Some(x))).map(s),
        _ => None,
    }
}

fn sanitize_addons(v: Option<&JsValue>) -> Option<JsValue> {
    let o = v?.obj()?;
    let cat = catalog::get();
    let mut out = Obj::new();
    for id in &cat.addons {
        let raw = match o.get(id) {
            None | Some(JsValue::Null) | Some(JsValue::Bool(false)) => continue,
            Some(r) => r,
        };
        let mut vals = Obj::new();
        if let Some(src) = raw.obj() {
            for spec in cat.effect(id) {
                if let Some(c) = src.get(&spec.key).and_then(|x| coerce_effect_param(spec, x)) {
                    vals.set(&spec.key, c);
                }
            }
        }
        out.set(id, JsValue::Obj(vals));
    }
    some_obj(out)
}

// ── face shader layers ──────────────────────────────────────────────────────────

/// A parameter spec as `coerceParam` sees it: type and option values.
struct Spec {
    key: String,
    ty: ParamType,
    options: Vec<f64>,
}

/// `layerParams(layer)`: a custom layer's annotations, else the built-in's table.
fn layer_specs(layer: &Obj) -> Vec<Spec> {
    if layer.get("id").and_then(JsValue::str) == Some("custom") {
        let code = layer.get("code").and_then(JsValue::str).unwrap_or("");
        let wgsl = layer.get("language").and_then(JsValue::str) == Some("wgsl");
        return custom_parse::parse(code, wgsl).params.into_iter().map(|p| Spec { key: p.key, ty: p.ty, options: p.options }).collect();
    }
    let id = layer.get("id").and_then(JsValue::str).unwrap_or("");
    catalog::get()
        .shader(id)
        .map(|d| {
            d.params
                .iter()
                .map(|p| Spec {
                    key: p.key.clone(),
                    ty: match p.ty.as_str() {
                        "float" => ParamType::Float,
                        "int" => ParamType::Int,
                        "bool" => ParamType::Bool,
                        "color" => ParamType::Color,
                        "vec2" => ParamType::Vec2,
                        "vec3" => ParamType::Vec3,
                        _ => ParamType::Other,
                    },
                    options: p.options.iter().filter_map(JsValue::num).collect(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `coerceParam`.
fn coerce_param(spec: &Spec, v: &JsValue) -> Option<JsValue> {
    let finite_all = |a: &[JsValue]| a.iter().all(|x| x.num().is_some());
    match spec.ty {
        ParamType::Float | ParamType::Int => {
            let x = match v {
                JsValue::Bool(b) => *b as u8 as f64,
                other => other.num()?,
            };
            let value = if spec.ty == ParamType::Int { round(x) } else { x };
            if !spec.options.is_empty() && !spec.options.contains(&value) {
                return None;
            }
            Some(n(value))
        }
        ParamType::Bool => match v {
            JsValue::Bool(b) => Some(JsValue::Bool(*b)),
            other => other.num().map(|x| JsValue::Bool(x != 0.0)),
        },
        ParamType::Color => match v {
            JsValue::Arr(a) if a.len() == 3 && finite_all(a) => Some(JsValue::Arr(a.clone())),
            JsValue::Str(t) => {
                let c = custom_parse::shader_color(t)?;
                let byte = |x: f64| format!("{:02x}", round(clamp(x, 0.0, 1.0) * 255.0) as u32);
                Some(s(&format!("#{}{}{}", byte(c[0]), byte(c[1]), byte(c[2]))))
            }
            _ => None,
        },
        ParamType::Vec2 | ParamType::Vec3 => {
            let len = if spec.ty == ParamType::Vec2 { 2 } else { 3 };
            match v {
                JsValue::Arr(a) if a.len() == len && finite_all(a) => Some(JsValue::Arr(a.clone())),
                _ => None,
            }
        }
        ParamType::Other => None,
    }
}

/// `sanitizeParamValue`.
fn sanitize_param_value(v: &JsValue) -> Option<JsValue> {
    match v {
        JsValue::Num(x) if x.is_finite() => Some(v.clone()),
        JsValue::Bool(_) => Some(v.clone()),
        JsValue::Str(t) => (len16(t) <= 32).then(|| v.clone()),
        JsValue::Arr(a) if (a.len() == 2 || a.len() == 3) && a.iter().all(|x| x.num().is_some()) => Some(v.clone()),
        _ => None,
    }
}

/// `/^[A-Za-z_]\w{0,63}$/`.
fn param_key(k: &str) -> bool {
    k.len() <= 64 && k.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && k.chars().all(is_word)
}

/// `sanitizeLayer`: one layer from untrusted JSON, or `None`.
pub(super) fn sanitize_layer(v: &JsValue) -> Option<JsValue> {
    let o = v.obj()?;
    let id = o.get("id")?.str()?;
    let custom = id == "custom";
    let cat = catalog::get();
    let def = if custom { None } else { Some(cat.shader(id)?) };
    let mut code = None;
    if custom {
        let c = o.get("code").and_then(JsValue::str)?;
        if trim(c).is_empty() || len16(c) > MAX_CUSTOM_CODE {
            return None;
        }
        code = Some(c);
    }
    let both = ["skin".to_string(), "overlay".to_string()];
    let targets = def.map_or(&both[..], |d| &d.targets[..]);
    let side = o.get("side").and_then(JsValue::str).filter(|x| matches!(*x, "back" | "both")).unwrap_or("front");
    let target = match o.get("target").and_then(JsValue::str) {
        Some(t @ ("skin" | "overlay")) if targets.iter().any(|x| x == t) => t.to_string(),
        _ => def.map_or("skin".to_string(), |d| d.default_target.clone()),
    };
    let mut layer = Obj::new();
    layer.set("id", s(id));
    layer.set("side", s(side));
    layer.set("target", s(&target));
    if let Some(b @ ("normal" | "add" | "multiply" | "screen")) = o.get("blend").and_then(JsValue::str) {
        layer.set("blend", s(b));
    }
    if let Some(x) = o.get("opacity").and_then(JsValue::num) {
        layer.set("opacity", n(clamp(x, 0.0, 1.0)));
    }
    if let Some(b) = o.get("animated").and_then(JsValue::bool) {
        layer.set("animated", JsValue::Bool(b));
    }
    if let Some(x) = o.get("time").and_then(JsValue::num) {
        layer.set("time", n(clamp(x, 0.0, 3600.0)));
    }
    if let Some(b) = o.get("enabled").and_then(JsValue::bool) {
        layer.set("enabled", JsValue::Bool(b));
    }
    if let Some(c) = code {
        layer.set("code", s(c));
    }
    if custom && o.get("language").and_then(JsValue::str) == Some("wgsl") {
        layer.set("language", s("wgsl"));
    }
    if let Some(raw) = o.get("params").and_then(JsValue::obj) {
        let mut params = Obj::new();
        // `params[k] = …` with k "__proto__" sets the prototype, never an own property.
        for (k, x) in raw.iter().take(MAX_LAYER_PARAMS) {
            if !param_key(k) || k == "__proto__" {
                continue;
            }
            if let Some(pv) = sanitize_param_value(x) {
                params.set(k, pv);
            }
        }
        // `pruneLayerParams`.
        if !params.is_empty() {
            let mut next = Obj::new();
            for spec in layer_specs(&layer) {
                if let Some(c) = params.get(&spec.key).and_then(|x| coerce_param(&spec, x)) {
                    next.set(&spec.key, c);
                }
            }
            if !next.is_empty() {
                layer.set("params", JsValue::Obj(next));
            }
        }
    }
    Some(JsValue::Obj(layer))
}

fn sanitize_shaders(v: Option<&JsValue>) -> Option<JsValue> {
    let a = v?.arr()?;
    let out: Vec<JsValue> = a.iter().take(MAX_SHADER_LAYERS * 2).filter_map(sanitize_layer).take(MAX_SHADER_LAYERS).collect();
    (!out.is_empty()).then_some(JsValue::Arr(out))
}

// ── fonts ───────────────────────────────────────────────────────────────────────

/// `sanitizeFont`: a catalog id or a custom font.
pub(super) fn sanitize_font(v: Option<&JsValue>) -> Option<JsValue> {
    let v = v?;
    if let Some(id) = v.str().filter(|id| catalog::get().fonts.iter().any(|f| f == id)) {
        return Some(s(id));
    }
    sanitize_custom_font(v)
}

/// Runs of JavaScript whitespace → one space (`replace(/\s+/g, " ")`).
fn collapse_ws(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut in_ws = false;
    for c in t.chars() {
        if is_ws(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// `sanitizeGoogleFamily`.
fn google_family(v: &JsValue) -> Option<String> {
    let t = collapse_ws(trim(&v.str()?.replace('+', " ")));
    let ok = len16(&t) <= FONT_FAMILY_CHARS && t.starts_with(|c: char| c.is_ascii_alphanumeric()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ');
    ok.then_some(t)
}

/// `\p{L}` or `\p{N}`.
fn letter_or_number(c: char) -> bool {
    use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
    let gc = icu_properties::CodePointMapData::<GeneralCategory>::new().get(c);
    GeneralCategoryGroup::Letter.contains(gc) || GeneralCategoryGroup::Number.contains(gc)
}

/// `sanitizeFontLabel`.
fn font_label(v: &JsValue) -> Option<String> {
    let t = v.str()?;
    let mut replaced = String::with_capacity(t.len());
    let mut run = false;
    for c in t.chars() {
        if letter_or_number(c) || matches!(c, ' ' | '.' | '_' | '-') {
            replaced.push(c);
            run = false;
        } else {
            if !run {
                replaced.push(' ');
            }
            run = true;
        }
    }
    let out = trim(&slice16(trim(&collapse_ws(&replaced)), 0, FONT_FAMILY_CHARS)).to_string();
    (!out.is_empty()).then_some(out)
}

/// `/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i`.
fn loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host == "[::1]" {
        return true;
    }
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts[0] == "127" && parts[1..].iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `sanitizeFontUrl`.
fn font_url(v: &JsValue) -> Option<String> {
    let t = trim(v.str()?);
    if t.is_empty() || len16(t) > FONT_URL_CHARS || t.chars().any(|c| is_ws(c) || "\"'`()<>\\".contains(c)) {
        return None;
    }
    // `/^[a-z][a-z0-9+.-]*:/i`.
    let scheme = t.starts_with(|c: char| c.is_ascii_alphabetic()) && {
        let end = t.find(|c: char| !(c.is_ascii_alphanumeric() || "+.-".contains(c))).unwrap_or(t.len());
        t[end..].starts_with(':')
    };
    if !scheme {
        return (!t.starts_with("//")).then(|| t.to_string());
    }
    let u = url::Url::parse(t).ok()?;
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let ok = u.scheme() == "https" || (u.scheme() == "http" && u.host_str().is_some_and(loopback));
    ok.then(|| u.as_str().to_string())
}

/// `isFontDataUrl`.
pub(super) fn is_font_data_url(v: &str) -> bool {
    const TYPES: [&str; 14] = [
        "font/woff2",
        "font/woff",
        "font/ttf",
        "font/otf",
        "font/sfnt",
        "font/collection",
        "application/font-woff",
        "application/font-woff2",
        "application/x-font-woff",
        "application/x-font-ttf",
        "application/x-font-otf",
        "application/font-sfnt",
        "application/vnd.ms-opentype",
        "application/octet-stream",
    ];
    if len16(v) > FONT_UPLOAD_CHARS {
        return false;
    }
    let Some(rest) = v.strip_prefix("data:") else { return false };
    let Some(b64) = TYPES.iter().find_map(|t| rest.strip_prefix(t).and_then(|r| r.strip_prefix(";base64,"))) else { return false };
    let body = b64.trim_end_matches('=');
    b64.len() - body.len() <= 2 && !body.is_empty() && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// `decodeURIComponent`, or `None` where it throws.
fn decode_uri_component(t: &str) -> Option<String> {
    let b = t.as_bytes();
    let mut out = String::with_capacity(t.len());
    let mut i = 0;
    let hex = |i: usize| -> Option<u8> {
        if b.get(i) != Some(&b'%') {
            return None;
        }
        let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
        u8::from_str_radix(h, 16).ok().filter(|_| h.bytes().all(|c| c.is_ascii_hexdigit()))
    };
    while i < b.len() {
        if b[i] != b'%' {
            let c = t[i..].chars().next()?;
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        let first = hex(i)?;
        let len = match first {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        let mut bytes = vec![first];
        for k in 1..len {
            bytes.push(hex(i + 3 * k)?);
        }
        out.push_str(std::str::from_utf8(&bytes).ok()?);
        i += 3 * len;
    }
    Some(out)
}

/// `familyFromFileName`.
fn family_from_file_name(name: &str) -> String {
    let file = name.split(['?', '#']).next().unwrap_or("").rsplit('/').next().unwrap_or("");
    let lower = file.to_ascii_lowercase();
    let ext = [".woff2", ".woff", ".ttf", ".otf"].iter().find(|e| lower.ends_with(*e)).map_or(0, |e| e.len());
    let base = &file[..file.len() - ext];
    let base = decode_uri_component(base).unwrap_or_else(|| base.to_string());
    let mut spaced = String::with_capacity(base.len());
    let mut run = false;
    for c in base.chars() {
        if c == '-' || c == '_' {
            if !run {
                spaced.push(' ');
            }
            run = true;
        } else {
            spaced.push(c);
            run = false;
        }
    }
    font_label(&JsValue::Str(spaced)).unwrap_or_else(|| "Custom font".to_string())
}

/// `typeof v === "number" && Number.isInteger(v) && 100 ≤ v ≤ 900 && v % 100 === 0`.
fn weight_of(v: f64) -> Option<f64> {
    (v.is_finite() && v.fract() == 0.0 && (100.0..=900.0).contains(&v) && v % 100.0 == 0.0).then_some(v)
}

fn google(family: String, weight: Option<f64>) -> JsValue {
    let mut o = Obj::new();
    o.set("source", s("google"));
    o.set("family", s(&family));
    if let Some(w) = weight.filter(|&w| w != FONT_WEIGHT) {
        o.set("weight", n(w));
    }
    JsValue::Obj(o)
}

/// `sanitizeCustomFont`.
fn sanitize_custom_font(v: &JsValue) -> Option<JsValue> {
    if let JsValue::Str(spec) = v {
        // `parseGoogleFontSpec`: /^google:([^@]*?)(?:@(\d+))?$/i on the trimmed text.
        let t = trim(spec);
        if t.len() < 7 || !t.is_char_boundary(7) || !t[..7].eq_ignore_ascii_case("google:") {
            return None;
        }
        let rest = &t[7..];
        let (fam, digits) = match rest.split_once('@') {
            Some((f, d)) if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) => (f, Some(d)),
            Some(_) => return None,
            None => (rest, None),
        };
        let family = google_family(&s(fam))?;
        let weight = match digits {
            Some(d) => Some(weight_of(string_to_number(d))?),
            None => None,
        };
        return Some(google(family, weight));
    }
    let o = v.obj()?;
    match o.get("source").and_then(JsValue::str) {
        Some("google") => {
            let family = google_family(o.get("family")?)?;
            Some(google(family, o.get("weight").and_then(JsValue::num).and_then(weight_of)))
        }
        Some("url") => {
            let src = font_url(o.get("src")?)?;
            let family = o.get("family").and_then(font_label).unwrap_or_else(|| family_from_file_name(&src));
            let mut out = Obj::new();
            out.set("source", s("url"));
            out.set("family", s(&family));
            out.set("src", s(&src));
            Some(JsValue::Obj(out))
        }
        Some("upload") => {
            let family = font_label(o.get("family")?)?;
            let mut out = Obj::new();
            out.set("source", s("upload"));
            out.set("family", s(&family));
            if let Some(src) = o.get("src").and_then(JsValue::str).filter(|v| is_font_data_url(v)) {
                out.set("src", s(src));
            }
            Some(JsValue::Obj(out))
        }
        _ => None,
    }
}

// ── logo, body, text, scene ─────────────────────────────────────────────────────

fn pair(v: Option<&JsValue>, positive: bool) -> Option<[f64; 2]> {
    let a = v?.arr()?;
    if a.len() != 2 {
        return None;
    }
    let x = a[0].num().filter(|&x| !positive || x > 0.0)?;
    let y = a[1].num().filter(|&y| !positive || y > 0.0)?;
    Some([x, y])
}

/// `/^[\sMmLlHhVvCcSsQqTtAaZz0-9eE.,+-]+$/`.
fn path_data(p: &str) -> bool {
    !p.is_empty() && p.chars().all(|c| is_ws(c) || "MmLlHhVvCcSsQqTtAaZz0123456789eE.,+-".contains(c))
}

/// `/^(data:image\/(png|webp|jpeg|gif);base64,|https?:|\/)/i`.
fn logo_src(v: &str) -> bool {
    let starts = |p: &str| v.len() >= p.len() && v.is_char_boundary(p.len()) && v[..p.len()].eq_ignore_ascii_case(p);
    ["data:image/png;base64,", "data:image/webp;base64,", "data:image/jpeg;base64,", "data:image/gif;base64,", "http:", "https:", "/"].iter().any(|p| starts(p))
}

/// `sanitizeLogo`.
pub(super) fn sanitize_logo(v: Option<&JsValue>) -> Option<JsValue> {
    let o = v?.obj()?;
    let cat = catalog::get();
    let mut out = Obj::new();
    let view_box = pair(o.get("viewBox"), true);
    let path = o.get("path").and_then(JsValue::str);
    let src = o.get("src").and_then(JsValue::str);
    if let (Some(p), Some(vb)) = (path.filter(|p| !trim(p).is_empty() && len16(p) <= cat.logo_path_chars && path_data(p)), view_box) {
        out.set("path", s(p));
        out.set("viewBox", JsValue::Arr(vec![n(vb[0]), n(vb[1])]));
        if let Some(origin) = pair(o.get("origin"), false).filter(|o| o[0] != 0.0 || o[1] != 0.0) {
            out.set("origin", JsValue::Arr(vec![n(origin[0]), n(origin[1])]));
        }
        if o.get("fillRule").and_then(JsValue::str) == Some("evenodd") {
            out.set("fillRule", s("evenodd"));
        }
    } else {
        let src = src.filter(|t| len16(t) <= cat.logo_src_chars && logo_src(t))?;
        out.set("src", s(src));
        if let Some(a) = o.get("aspect").and_then(JsValue::num).filter(|&a| a > 0.0) {
            out.set("aspect", n(a));
        }
    }
    if let Some(p) = o.get("position").and_then(JsValue::str).filter(|p| *p != "corner" && cat.logo_positions.iter().any(|x| x == p)) {
        out.set("position", s(p));
    }
    if let Some(x) = o.get("scale").and_then(JsValue::num) {
        let k = clamp(x, cat.logo_scale.0, cat.logo_scale.1);
        if k != 1.0 {
            out.set("scale", n(round_to(k, 100.0)));
        }
    }
    Some(JsValue::Obj(out))
}

fn mark_finish(v: Option<&JsValue>) -> Option<&str> {
    v.and_then(JsValue::str).filter(|f| MARK_FINISHES.contains(f))
}

fn sanitize_finish(v: Option<&JsValue>) -> Option<JsValue> {
    let o = v?.obj()?;
    let mut out = Obj::new();
    for k in ["name", "bio", "logo"] {
        if let Some(f) = mark_finish(o.get(k)) {
            out.set(k, s(f));
        }
    }
    some_obj(out)
}

fn sanitize_edge(v: Option<&JsValue>) -> Option<JsValue> {
    let o = v?.obj()?;
    let mut out = Obj::new();
    let finish = o.get("finish").and_then(JsValue::str).filter(|f| ["metal", "anodized", "match"].contains(f));
    if let Some(f) = finish {
        out.set("finish", s(f));
        if f != "match" {
            if let Some(c) = hex_trimmed(o.get("color")) {
                out.set("color", s(&c));
            }
        }
    }
    let chamfer = o.get("chamfer") == Some(&JsValue::Bool(true));
    if chamfer {
        out.set("chamfer", JsValue::Bool(true));
    }
    (finish.is_some() || chamfer).then_some(JsValue::Obj(out))
}

fn sanitize_shape(v: Option<&JsValue>) -> Option<JsValue> {
    let o = v?.obj()?;
    let (min, iso, max) = catalog::get().corner_radius;
    let mut out = Obj::new();
    let radius = o.get("cornerRadius").and_then(JsValue::num).map(|r| clamp(round_to(r, 1000.0), min, max));
    if let Some(r) = radius.filter(|r| (r - iso).abs() >= 5e-4) {
        out.set("cornerRadius", n(r));
    }
    if o.get("orientation").and_then(JsValue::str) == Some("portrait") {
        out.set("orientation", s("portrait"));
    }
    if let Some(a) = o.get("cutouts").and_then(JsValue::arr) {
        let cuts: Vec<JsValue> = CUTOUTS.iter().filter(|c| a.iter().any(|x| x.str() == Some(c))).map(|c| s(c)).collect();
        if !cuts.is_empty() {
            out.set("cutouts", JsValue::Arr(cuts));
        }
    }
    some_obj(out)
}

fn sanitize_contactless(v: Option<&JsValue>) -> Option<JsValue> {
    let v = v?;
    if v == &JsValue::Bool(true) {
        return Some(JsValue::Obj(Obj::new()));
    }
    let o = v.obj()?;
    let (min, max) = catalog::get().contactless_scale;
    let mut out = Obj::new();
    if let Some(f) = o.get("finish").and_then(JsValue::str).filter(|f| *f == "default" || MARK_FINISHES.contains(f)) {
        out.set("finish", s(f));
    }
    if let Some(x) = o.get("scale").and_then(JsValue::num) {
        out.set("scale", n(round_to(clamp(x, min, max), 100.0)));
    }
    Some(JsValue::Obj(out))
}

pub(super) const TEXT_LINE_MAX: usize = 3;
const TEXT_LINE_CHARS: usize = 48;

fn sanitize_text_lines(v: Option<&JsValue>, fonts: &[String]) -> Option<JsValue> {
    let a = v?.arr()?;
    let mut out = Vec::new();
    for raw in a {
        if out.len() >= TEXT_LINE_MAX {
            break;
        }
        let Some(o) = raw.obj() else { continue };
        let Some(text) = o.get("text").and_then(JsValue::str) else { continue };
        let mut line = Obj::new();
        // `replace(/[\r\n]+/g, " ")`, then the first 48 UTF-16 units.
        let mut flat = String::with_capacity(text.len());
        let mut run = false;
        for c in text.chars() {
            if c == '\r' || c == '\n' {
                if !run {
                    flat.push(' ');
                }
                run = true;
            } else {
                flat.push(c);
                run = false;
            }
        }
        line.set("text", s(&slice16(&flat, 0, TEXT_LINE_CHARS)));
        if let Some(f) = o.get("font").and_then(JsValue::str).filter(|f| fonts.iter().any(|x| x == f)) {
            line.set("font", s(f));
        }
        if let Some(x) = o.get("size").and_then(JsValue::num) {
            line.set("size", n(round_to(clamp(x, 0.4, 2.0), 100.0)));
        }
        if let Some(x) = o.get("tracking").and_then(JsValue::num) {
            line.set("tracking", n(round_to(clamp(x, -0.05, 0.6), 1000.0)));
        }
        if let Some(al) = o.get("align").and_then(JsValue::str).filter(|x| ALIGNS.contains(x)) {
            line.set("align", s(al));
        }
        if let Some(p) = o.get("placement").and_then(JsValue::str).filter(|x| PLACEMENTS.contains(x)) {
            line.set("placement", s(p));
        }
        out.push(JsValue::Obj(line));
    }
    (!out.is_empty()).then_some(JsValue::Arr(out))
}

/// The scene environment: a catalog-style id (`/^[a-z0-9][a-z0-9-]{0,40}$/`) or an http(s), site or
/// relative URL of an `.hdr` / `.webp` file
/// (`/^(https?:\/\/|\/|\.{1,2}\/)[^\s"'<>]*\.(hdr|webp)([?#][^\s"'<>]*)?$/i`).
fn environment(env: &str) -> bool {
    let id = !env.is_empty()
        && env.len() <= 41
        && env.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && env.bytes().next().is_some_and(|b| b != b'-');
    if id {
        return true;
    }
    let lower = env.to_ascii_lowercase();
    let prefix = ["http://", "https://", "/", "./", "../"].iter().any(|p| lower.starts_with(p));
    if !prefix || env.chars().any(|c| is_ws(c) || "\"'<>".contains(c)) {
        return false;
    }
    [".hdr", ".webp"].iter().any(|ext| {
        lower.match_indices(ext).any(|(i, _)| {
            let after = &lower[i + ext.len()..];
            after.is_empty() || after.starts_with(['?', '#'])
        })
    })
}

fn sanitize_scene(v: Option<&JsValue>) -> Option<JsValue> {
    let o = v?.obj()?;
    let mut out = Obj::new();
    let env = o.get("environment").and_then(JsValue::str).map(trim).unwrap_or("");
    if !env.is_empty() && env != "studio" && len16(env) <= 2048 && environment(env) {
        out.set("environment", s(env));
    }
    if let Some(x) = o.get("environmentIntensity").and_then(JsValue::num) {
        let k = round_to(clamp(x, 0.25, 3.0), 100.0);
        if k != 1.0 {
            out.set("environmentIntensity", n(k));
        }
    }
    if let Some(x) = o.get("environmentRotation").and_then(JsValue::num) {
        let r = round_to(((x % 360.0) + 360.0) % 360.0, 10.0);
        if r != 0.0 {
            out.set("environmentRotation", n(r));
        }
    }
    if let Some(b) = o.get("backdrop").and_then(JsValue::str).filter(|b| *b != "none" && BACKDROPS.contains(b)) {
        out.set("backdrop", s(b));
    }
    if let Some(c) = hex_trimmed(o.get("backdropColor")) {
        out.set("backdropColor", s(&c));
    }
    if let Some(x) = o.get("backdropBlur").and_then(JsValue::num) {
        out.set("backdropBlur", n(round_to(clamp(x, 0.0, 1.0), 100.0)));
    }
    match o.get("floor") {
        Some(JsValue::Bool(true)) => out.set("floor", JsValue::Obj(Obj::new())),
        Some(JsValue::Obj(f)) => {
            let mut floor = Obj::new();
            for k in ["reflectivity", "shadow", "blur"] {
                if let Some(x) = f.get(k).and_then(JsValue::num) {
                    floor.set(k, n(round_to(clamp(x, 0.0, 1.0), 100.0)));
                }
            }
            out.set("floor", JsValue::Obj(floor));
        }
        _ => {}
    }
    some_obj(out)
}
