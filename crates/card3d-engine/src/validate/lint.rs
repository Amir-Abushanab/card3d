//! `lintDesign` (packages/core/src/describe/lint.ts): what `ensureDesign` rejected, dropped or clamped,
//! in the same words, paths and order.

use super::catalog::{self, Catalog};
use super::custom_parse;
use super::js::{len16, number_to_string, slice16, stringify, trim, JsValue, Obj};
use super::sanitize::{self, is_hex, MAX_CUSTOM_CODE, MAX_SHADER_LAYERS};
use super::Issue;

pub struct Lint {
    pub design: Option<JsValue>,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}

/// `show`: JSON, cut to 57 characters and an ellipsis past 60.
fn show(v: &JsValue) -> String {
    let s = stringify(v);
    if len16(&s) > 60 {
        format!("{}…", slice16(&s, 0, 57))
    } else {
        s
    }
}

fn list<S: AsRef<str>>(xs: &[S]) -> String {
    xs.iter().map(|x| stringify(&JsValue::Str(x.as_ref().to_string()))).collect::<Vec<_>>().join(", ")
}

/// `a !== b` for a value read from the input against one the sanitizer produced (objects are never
/// the same object).
fn differs(a: &JsValue, b: Option<&JsValue>) -> bool {
    match (a, b) {
        (JsValue::Null, Some(JsValue::Null)) => false,
        (JsValue::Bool(x), Some(JsValue::Bool(y))) => x != y,
        (JsValue::Num(x), Some(JsValue::Num(y))) => x != y,
        (JsValue::Str(x), Some(JsValue::Str(y))) => x != y,
        _ => true,
    }
}

/// `${v}` for a primitive.
fn text(v: Option<&JsValue>) -> String {
    match v {
        None => "undefined".into(),
        Some(JsValue::Null) => "null".into(),
        Some(JsValue::Bool(b)) => b.to_string(),
        Some(JsValue::Num(n)) => number_to_string(*n),
        Some(JsValue::Str(s)) => s.clone(),
        Some(JsValue::Arr(_)) | Some(JsValue::Obj(_)) => stringify(v.unwrap_or(&JsValue::Null)),
    }
}

struct Out {
    errors: Vec<Issue>,
    warnings: Vec<Issue>,
}

impl Out {
    fn err(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.errors.push(Issue { path: path.into(), message: message.into() });
    }
    fn warn(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.warnings.push(Issue { path: path.into(), message: message.into() });
    }
}

/// `lintDesign(input)` for JSON text.
pub(super) fn lint(text_in: &str) -> Lint {
    let mut out = Out { errors: vec![], warnings: vec![] };
    let raw = match super::js::parse(text_in) {
        Ok(v) => v,
        Err(e) => {
            out.err("", format!("not valid JSON: {e}"));
            return Lint { design: None, errors: out.errors, warnings: out.warnings };
        }
    };
    lint_value(&raw)
}

/// `lintDesign(input)` for a parsed value.
pub(super) fn lint_value(raw: &JsValue) -> Lint {
    let mut out = Out { errors: vec![], warnings: vec![] };
    let Some(r) = raw.obj() else {
        out.err("", "expected a JSON object (a CardDesign)");
        return Lint { design: None, errors: out.errors, warnings: out.warnings };
    };
    let design = match sanitize::ensure_design(raw) {
        Ok(d) => d,
        Err(e) => {
            out.err("", e);
            return Lint { design: None, errors: out.errors, warnings: out.warnings };
        }
    };
    check(r, &design, &mut out);
    Lint { design: Some(design), errors: out.errors, warnings: out.warnings }
}

fn check(raw: &Obj, design: &JsValue, out: &mut Out) {
    let cat = catalog::get();
    let d = design.obj().cloned().unwrap_or_default();
    let empty = Obj::new();

    // ── top level ──
    let bare_recipe =
        raw.get("recipe").and_then(JsValue::obj).is_none() && ["material", "texture", "grain", "polish", "holoStyle", "frontHolo"].iter().any(|k| raw.has(k));
    let raw_recipe: &Obj = match raw.get("recipe") {
        Some(JsValue::Obj(o)) => o,
        _ if bare_recipe => raw,
        _ => &empty,
    };
    let fields = &cat.fields;
    for k in raw.keys() {
        if fields.design.iter().any(|f| f == k) || k == "ownerName" || (bare_recipe && cat.recipe_control(k).is_some()) {
            continue;
        }
        out.err(k, format!("unknown field (CardDesign fields: {})", fields.design.join(", ")));
    }

    // ── recipe ──
    let recipe = d.get("recipe").and_then(JsValue::obj).cloned().unwrap_or_default();
    let control_keys: Vec<&str> = cat.recipe_controls.iter().map(|c| c.key.as_str()).collect();
    for (k, v) in raw_recipe.iter() {
        let path = format!("recipe.{k}");
        let Some(control) = cat.recipe_control(k) else {
            out.err(path, format!("unknown recipe field (fields: {})", control_keys.join(", ")));
            continue;
        };
        if matches!(v, JsValue::Null) {
            continue;
        }
        let kept = recipe.get(k);
        match control.kind.as_str() {
            "enum" => {
                if differs(v, kept) {
                    out.err(path, format!("{} is not one of {}", show(v), list(&control.options)));
                }
            }
            "range" => match v {
                JsValue::Num(x) if x.is_finite() => {
                    if *x < control.min || *x > control.max {
                        out.warn(
                            path,
                            format!(
                                "{} is outside {}–{} (the engine clamps it)",
                                number_to_string(*x),
                                number_to_string(control.min),
                                number_to_string(control.max)
                            ),
                        );
                    }
                }
                _ => out.err(path, format!("expected a number, got {}", show(v))),
            },
            "color" => {
                if !v.str().is_some_and(|c| is_hex(trim(c))) {
                    out.err(path, format!("expected a \"#rrggbb\" colour, got {}", show(v)));
                }
            }
            _ => {
                if v.bool().is_none() {
                    out.warn(path, format!("expected true or false, got {} (read as {})", show(v), text(kept)));
                }
            }
        }
    }
    let num = |k: &str| recipe.get(k).and_then(JsValue::num).unwrap_or(0.0);
    if recipe.get("texture").and_then(JsValue::str) == Some("none")
        && (num("grain") > 0.0 || num("relief") > 0.0)
        && ["texture", "grain", "relief"].iter().any(|k| raw_recipe.has(k))
    {
        out.warn(
            "recipe.texture",
            format!(
                "\"none\" with grain {} / relief {} renders as brushed metal; set grain and relief to 0 for a flat finish, or texture \"brushed\"",
                number_to_string(num("grain")),
                number_to_string(num("relief"))
            ),
        );
    }
    let foil_keys = ["holoStyle", "foilTexture", "foilIntensity", "holoGlare", "foilScale", "foilCoverage"];
    if recipe.get("frontHolo") != Some(&JsValue::Bool(true)) && foil_keys.iter().any(|k| raw_recipe.has(k)) {
        out.warn("recipe.frontHolo", "foil fields are set but frontHolo is false, so no foil shows");
    }

    // ── ids from catalogs ──
    let present = |k: &str| raw.get(k).filter(|v| !matches!(v, JsValue::Null));
    if let Some(f) = present("font") {
        if d.get("font").is_none() {
            out.err("font", format!("{} is not a font id ({}) or a custom font ({{ source: \"google\", family }})", show(f), list(&cat.fonts)));
        }
    }
    if let Some(l) = present("lighting") {
        if differs(l, d.get("lighting")) {
            out.err("lighting", format!("{} is not a lighting preset ({})", show(l), list(&cat.lighting)));
        }
    }
    if raw.get("decals").and_then(JsValue::arr).is_some_and(|a| !a.is_empty()) {
        out.warn("decals", "stickers need uploaded images; write []");
    }
    for k in ["surfaceSources", "surfaceTreatments"] {
        if raw.get(k).and_then(JsValue::obj).is_some_and(|o| !o.is_empty()) {
            out.warn(k, "artwork needs uploaded images; write {}");
        }
    }

    // ── nested objects: unknown keys are errors, dropped or changed values are warnings ──
    let flat = |out: &mut Out, key: &str, fields: &[String], allow_true: bool| {
        let v = match raw.get(key) {
            None | Some(JsValue::Null) => return,
            Some(JsValue::Bool(true)) if allow_true => return,
            Some(v) => v,
        };
        let Some(given) = v.obj() else { return out.err(key, format!("expected an object, got {}", show(v))) };
        let kept = d.get(key).and_then(JsValue::obj);
        compare_object(out, key, given, kept.unwrap_or(&Obj::new()), fields);
        if kept.is_none() {
            out.warn(key, "nothing usable was left, so it was dropped");
        }
    };
    flat(out, "materialOverride", &fields.material_override, false);
    flat(out, "brandingOverride", &fields.branding_override, false);
    let layout: Vec<String> = sanitize::LAYOUT_RANGES.iter().map(|(k, _, _)| k.to_string()).collect();
    flat(out, "frontLayout", &layout, false);
    flat(out, "finish", &fields.finish, false);
    flat(out, "edge", &fields.edge, false);
    flat(out, "shape", &fields.shape, false);
    flat(out, "contactless", &fields.contactless, true);
    flat(out, "logo", &fields.logo, false);
    flat(out, "addons", &fields.addon, false);
    match raw.get("scene") {
        Some(JsValue::Obj(scene)) => {
            let mut rest = Obj::new();
            for (k, v) in scene.iter().filter(|(k, _)| *k != "floor") {
                rest.set(k, v.clone());
            }
            let kept = d.get("scene").and_then(JsValue::obj);
            compare_object(out, "scene", &rest, kept.unwrap_or(&empty), &fields.scene);
            if let Some(floor) = scene.get("floor").and_then(JsValue::obj) {
                let kept_floor = kept.and_then(|s| s.get("floor")).and_then(JsValue::obj);
                compare_object(out, "scene.floor", floor, kept_floor.unwrap_or(&empty), &fields.floor);
            }
        }
        None | Some(JsValue::Null) => {}
        Some(v) => out.err("scene", format!("expected an object, got {}", show(v))),
    }
    for id in ["shine", "vines"] {
        if let Some(a) = raw.get("addons").and_then(|x| x.at(id)).and_then(JsValue::obj) {
            let keys: Vec<String> = cat.effect(id).iter().map(|p| p.key.clone()).collect();
            let kept = d.get("addons").and_then(|x| x.at(id)).and_then(JsValue::obj);
            compare_object(out, &format!("addons.{id}"), a, kept.unwrap_or(&empty), &keys);
        }
    }
    if let Some(lines) = raw.get("textLines").and_then(JsValue::arr) {
        let kept = d.get("textLines").and_then(JsValue::arr).unwrap_or(&[]);
        for (i, line) in lines.iter().enumerate() {
            match line.obj().filter(|o| o.get("text").and_then(JsValue::str).is_some()) {
                None => out.err(format!("textLines[{i}]"), "expected { text, … }"),
                Some(o) => compare_object(out, &format!("textLines[{i}]"), o, kept.get(i).and_then(JsValue::obj).unwrap_or(&empty), &fields.text_line),
            }
        }
        if lines.len() > kept.len() {
            out.warn("textLines", format!("only {} line(s) kept (≤ 3, each with text)", kept.len()));
        }
    }

    // ── shader layers ──
    match raw.get("shaders") {
        None | Some(JsValue::Null) => {}
        Some(JsValue::Arr(layers)) => {
            if layers.len() > MAX_SHADER_LAYERS {
                out.err("shaders", format!("at most {MAX_SHADER_LAYERS} layers"));
            }
            let glass = recipe.get("material").and_then(JsValue::str) == Some("glass");
            for (i, l) in layers.iter().take(MAX_SHADER_LAYERS).enumerate() {
                lint_layer(out, cat, &format!("shaders[{i}]"), l, glass);
            }
        }
        Some(_) => out.err("shaders", "expected an array of layers"),
    }
}

fn compare_object(out: &mut Out, path: &str, given: &Obj, kept: &Obj, fields: &[String]) {
    for (k, v) in given.iter() {
        let p = format!("{path}.{k}");
        if !fields.iter().any(|f| f == k) {
            out.err(p, format!("unknown field (fields: {})", fields.join(", ")));
            continue;
        }
        if matches!(v, JsValue::Null) {
            continue;
        }
        match (kept.get(k), v) {
            (None, _) => out.warn(p, format!("{} was ignored (wrong type, out of the allowed values, a default, or it doesn't apply here)", show(v))),
            (Some(JsValue::Num(k)), JsValue::Num(x)) if (x - k).abs() > 1e-9 => {
                out.warn(p, format!("{} was clamped to {}", number_to_string(*x), number_to_string(*k)))
            }
            _ => {}
        }
    }
}

fn lint_layer(out: &mut Out, cat: &Catalog, path: &str, l: &JsValue, glass: bool) {
    let Some(o) = l.obj() else { return out.err(path, "expected a layer object { id, side, target, … }") };
    for k in o.keys() {
        if !cat.fields.layer.iter().any(|f| f == k) {
            out.err(format!("{path}.{k}"), format!("unknown field (fields: {})", cat.fields.layer.join(", ")));
        }
    }
    let Some(kept) = sanitize::sanitize_layer(l) else {
        let Some(id) = o.get("id").and_then(JsValue::str) else { return out.err(format!("{path}.id"), "missing id") };
        if id == "custom" {
            let code = o.get("code").and_then(JsValue::str).filter(|c| !trim(c).is_empty());
            return match code {
                None => out.err(format!("{path}.code"), "a custom layer needs WGSL code"),
                Some(c) => out.err(format!("{path}.code"), format!("the code is {} characters; the limit is {MAX_CUSTOM_CODE}", len16(c))),
            };
        }
        let ids: Vec<&str> = cat.shaders.iter().map(|s| s.id.as_str()).collect();
        return out.err(format!("{path}.id"), format!("unknown shader {} (built-ins: {}, or \"custom\")", show(&JsValue::Str(id.into())), list(&ids)));
    };
    let k = kept.obj().cloned().unwrap_or_default();
    let id = k.get("id").and_then(JsValue::str).unwrap_or("");
    let custom = id == "custom";
    let def = if custom { None } else { cat.shader(id) };
    if let Some(side) = o.get("side") {
        if differs(side, k.get("side")) {
            out.err(format!("{path}.side"), format!("{} is not \"front\", \"back\" or \"both\"", show(side)));
        }
    }
    if let Some(target) = o.get("target") {
        if differs(target, k.get("target")) {
            let both = vec!["skin".to_string(), "overlay".to_string()];
            let targets = def.map_or(&both, |d| &d.targets);
            out.err(format!("{path}.target"), format!("{} isn't available for {id} (targets: {})", show(target), list(targets)));
        }
    }
    if let Some(blend) = o.get("blend") {
        if differs(blend, k.get("blend")) {
            out.err(format!("{path}.blend"), format!("{} is not \"normal\", \"add\", \"multiply\" or \"screen\"", show(blend)));
        }
    }
    if glass && k.get("target").and_then(JsValue::str) == Some("skin") {
        out.warn(format!("{path}.target"), "skins don't render on glass cards; use an overlay");
    }
    let code = k.get("code").and_then(JsValue::str).unwrap_or("");
    if custom {
        if k.get("language").and_then(JsValue::str) != Some("wgsl") {
            out.err(format!("{path}.language"), "custom layers are WGSL: set language: \"wgsl\" (GLSL layers are skipped)");
        }
        for e in custom_parse::parse(code, true).errors {
            let at = if e.line != 0 { format!(":{}", e.line) } else { String::new() };
            out.err(format!("{path}.code{at}"), e.message);
        }
    }
    if let Some(params) = o.get("params").and_then(JsValue::obj) {
        let kept_params = k.get("params").and_then(JsValue::obj);
        for (key, v) in params.iter() {
            if !kept_params.is_some_and(|p| p.has(key)) {
                let keys: Vec<String> = if custom {
                    custom_parse::parse(code, true).params.into_iter().map(|p| p.key).collect()
                } else {
                    def.map(|d| d.params.iter().map(|p| p.key.clone()).collect()).unwrap_or_default()
                };
                let names = if keys.is_empty() { "none".to_string() } else { keys.join(", ") };
                out.warn(format!("{path}.params.{key}"), format!("{} was ignored (params: {names})", show(v)));
            }
        }
    }
}
