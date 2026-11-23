//! Custom face shaders in WGSL (`custom-parse.ts`, rewritten for WGSL): `FaceShader { id: "custom",
//! language: "wgsl", code }`. The contract:
//!
//! ```wgsl
//! fn mainImage(uv: vec2f) -> vec4f { ... }   // required; display sRGB colour + straight alpha
//! ```
//!
//! plus any helpers. The prelude's globals, uniforms and helpers are in scope (see
//! shaders/face/prelude.wgsl); don't redeclare them or write entry points. User parameters are
//! private globals annotated on the same line, which the engine fills from the layer's params:
//!
//! ```wgsl
//! var<private> uSpeed: f32;   // @param 0 5 1 label="Speed"      min max default (+ step=, label=)
//! var<private> uCount: i32;   // @param 1 12 6
//! var<private> uGlow: bool;   // @param default=true
//! var<private> uCenter: vec2f; // @param 0 1 default=0.5,0.5
//! var<private> uTint: vec3f;  // @color #ff8800 label="Tint"
//! var<private> uMode: f32;    // @param options="Soft:0,Hard:1" default=1
//! ```
//!
//! A line `// @replaces-artwork` hides the face's own artwork layer. Loops are guarded: every `for`,
//! `while` and `loop` also checks a per-fragment budget of 10 000 iterations.

use crate::face_shaders::ParamType;
use crate::json::parse_f64;

/// One problem with a custom shader: a 1-based line of the user's code (0: the whole shader).
#[derive(Clone, Debug, PartialEq)]
pub struct ShaderError {
    pub line: u32,
    pub message: String,
}

/// A parsed custom parameter (owned: `ParamSpec` is the built-ins' static form).
#[derive(Clone, Debug, PartialEq)]
pub struct CustomParam {
    pub name: String,
    pub ty: ParamType,
    pub default: CustomDefault,
    pub options: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CustomDefault {
    Num(f64),
    Bool(bool),
    Vec(Vec<f64>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CustomParse {
    pub params: Vec<CustomParam>,
    pub errors: Vec<ShaderError>,
}

/// Names the prelude provides (`COMMON_UNIFORMS`, `COMMON_GLOBALS` and the loop guard).
const RESERVED: &[&str] = &[
    "uTime",
    "uResolution",
    "uTilt",
    "uPointer",
    "uBaseColor",
    "uArtwork",
    "uHasArtwork",
    "uChip",
    "uAspect",
    "uSide",
    "uOverlay",
    "uEye",
    "uOpacity",
    "cardUv",
    "facePos",
    "viewDir",
    "faceNormal",
    "card3dLoopGuard",
    "card3dGuard",
    "uSource",
];

/// Replaces comments with spaces (keeping line structure), so code scans ignore commented-out text.
pub fn strip_comments(code: &str) -> String {
    let b = code.as_bytes();
    let mut out = String::with_capacity(code.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                out.push(' ');
                i += 1;
            }
        } else if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            let end = code[i + 2..].find("*/").map_or(b.len(), |e| i + 2 + e + 2);
            for c in code[i..end].chars() {
                out.push(if c == '\n' { '\n' } else { ' ' });
            }
            i = end;
        } else {
            let c = code[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Whether `word` occurs in `s` as a whole word.
fn has_word(s: &str, word: &str) -> bool {
    s.match_indices(word).any(|(i, _)| {
        let before = s[..i].chars().next_back().is_none_or(|c| !is_ident(c));
        let after = s[i + word.len()..].chars().next().is_none_or(|c| !is_ident(c));
        before && after
    })
}

/// `var<private> NAME: TYPE;` at the start of a (comment-stripped) line.
fn declaration(line: &str) -> Option<(String, String)> {
    let rest = line.trim_start().strip_prefix("var")?.trim_start().strip_prefix("<")?.trim_start().strip_prefix("private")?.trim_start().strip_prefix(">")?;
    let rest = rest.trim_start();
    let name: String = rest.chars().take_while(|&c| is_ident(c)).collect();
    if name.is_empty() {
        return None;
    }
    let rest = rest[name.len()..].trim_start().strip_prefix(':')?;
    let ty: String = rest.trim_start().chars().take_while(|&c| c != ';' && c != '=').collect();
    rest.contains(';').then(|| (name, ty.split_whitespace().collect::<Vec<_>>().join("")))
}

fn param_type(ty: &str) -> Option<ParamType> {
    match ty {
        "f32" => Some(ParamType::Float),
        "i32" => Some(ParamType::Int),
        "bool" => Some(ParamType::Bool),
        "vec2f" | "vec2<f32>" => Some(ParamType::Vec2),
        "vec3f" | "vec3<f32>" => Some(ParamType::Vec3),
        _ => None,
    }
}

/// An annotation's tokens: bare words and key=value / key="quoted value" (`tokenize`).
fn tokenize(s: &str) -> (Vec<String>, Vec<(String, String)>) {
    let (mut positional, mut named) = (Vec::new(), Vec::new());
    let c: Vec<char> = s.chars().collect();
    let mut i = 0;
    let word = |i: &mut usize| {
        let start = *i;
        if c[*i] == '"' || c[*i] == '\'' {
            let q = c[*i];
            *i += 1;
            let s = *i;
            while *i < c.len() && c[*i] != q {
                *i += 1;
            }
            let v: String = c[s..*i].iter().collect();
            *i = (*i + 1).min(c.len());
            return v;
        }
        while *i < c.len() && !c[*i].is_whitespace() {
            *i += 1;
        }
        c[start..*i].iter().collect()
    };
    while i < c.len() {
        if c[i].is_whitespace() {
            i += 1;
            continue;
        }
        // key=value?
        let k_end = (i..c.len()).find(|&j| !(c[j].is_ascii_alphanumeric() || c[j] == '_')).unwrap_or(c.len());
        let after = (k_end..c.len()).find(|&j| !c[j].is_whitespace());
        if k_end > i && (c[i].is_ascii_alphabetic() || c[i] == '_') && after.is_some_and(|j| c[j] == '=') {
            let key: String = c[i..k_end].iter().collect::<String>().to_ascii_lowercase();
            let mut j = after.unwrap() + 1;
            while j < c.len() && c[j].is_whitespace() {
                j += 1;
            }
            if j >= c.len() {
                named.push((key, String::new()));
                break;
            }
            i = j;
            named.push((key, word(&mut i)));
        } else {
            positional.push(word(&mut i));
        }
    }
    (positional, named)
}

fn num(s: Option<&str>) -> Option<f64> {
    s.and_then(|s| parse_f64(s.trim())).filter(|n| n.is_finite())
}

fn parse_vector(s: &str, n: usize) -> Option<Vec<f64>> {
    let s = s.trim().trim_start_matches(['(', '[']).trim_end_matches([')', ']']);
    let parts: Vec<f64> = s.split(|c: char| c == ',' || c.is_whitespace()).filter(|p| !p.is_empty()).filter_map(parse_f64).collect();
    let count = s.split(|c: char| c == ',' || c.is_whitespace()).filter(|p| !p.is_empty()).count();
    if count == 1 && parts.len() == 1 {
        return Some(vec![parts[0]; n]);
    }
    (count == n && parts.len() == n && parts.iter().all(|v| v.is_finite())).then_some(parts)
}

/// `parseCustomShader` for WGSL: the annotated parameters and the errors (1-based lines).
pub fn parse(code: &str) -> CustomParse {
    let mut out = CustomParse::default();
    let bare = strip_comments(code);
    let mut seen: Vec<String> = Vec::new();
    for (i, (raw, stripped)) in code.split('\n').zip(bare.split('\n')).enumerate() {
        let line = i as u32 + 1;
        let err = |out: &mut CustomParse, m: String| out.errors.push(ShaderError { line, message: m });
        let Some((name, ty)) = declaration(stripped) else { continue };
        if RESERVED.contains(&name.as_str()) {
            err(&mut out, format!("\"{name}\" is provided by the face shader prelude; remove this declaration"));
            continue;
        }
        let Some(at) = raw.find("//").map(|k| &raw[k + 2..]).and_then(|c| c.trim_start().strip_prefix('@')) else { continue };
        let kind: String = at.chars().take_while(|&c| is_ident(c)).collect();
        if kind != "param" && kind != "color" {
            continue;
        }
        if seen.contains(&name) {
            err(&mut out, format!("\"{name}\" is declared twice"));
            continue;
        }
        let (positional, named) = tokenize(&at[kind.len()..]);
        let get = |k: &str| named.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        let pos = |k: usize| positional.get(k).map(String::as_str);

        if kind == "color" {
            if param_type(&ty) != Some(ParamType::Vec3) {
                err(&mut out, format!("@color needs a vec3f declaration (\"{name}\" is {ty})"));
                continue;
            }
            let given = get("default").or(pos(0)).unwrap_or("#ffffff");
            let rgb = crate::face_shaders::parse_color(&crate::json::Value::String(given.into()));
            if rgb.is_none() {
                err(&mut out, format!("@color default \"{given}\" is not a #rrggbb colour"));
            }
            let rgb = rgb.unwrap_or([1.0; 3]);
            let q = |x: f64| (x.clamp(0.0, 1.0) * 255.0 + 0.5).floor() / 255.0;
            seen.push(name.clone());
            out.params.push(CustomParam { name, ty: ParamType::Color, default: CustomDefault::Vec(rgb.iter().map(|&x| q(x)).collect()), options: vec![] });
            continue;
        }
        let Some(pty) = param_type(&ty) else {
            err(&mut out, format!("@param supports f32, i32, bool, vec2f and vec3f (\"{name}\" is {ty}); use @color for colours"));
            continue;
        };
        let mut options = Vec::new();
        let default = match pty {
            ParamType::Bool => {
                let d = get("default").or(pos(0)).unwrap_or("false").to_ascii_lowercase();
                if !matches!(d.as_str(), "true" | "false" | "1" | "0") {
                    err(&mut out, format!("bool default must be true or false (got \"{d}\")"));
                }
                CustomDefault::Bool(d == "true" || d == "1")
            }
            _ => {
                let (min_s, max_s) = (get("min").or(pos(0)), get("max").or(pos(1)));
                for (k, v) in [("min", min_s), ("max", max_s)] {
                    if let Some(v) = v.filter(|v| num(Some(v)).is_none()) {
                        err(&mut out, format!("{k} \"{v}\" is not a number"));
                    }
                }
                let (min, max) = (num(min_s), num(max_s));
                if let (Some(a), Some(b)) = (min, max) {
                    if a > b {
                        err(&mut out, format!("min {a} is greater than max {b}"));
                    }
                }
                let d_raw = get("default").or(pos(2));
                if matches!(pty, ParamType::Vec2 | ParamType::Vec3) {
                    let n = if pty == ParamType::Vec2 { 2 } else { 3 };
                    let v = match d_raw {
                        None => Some(vec![min.unwrap_or(0.0); n]),
                        Some(s) => parse_vector(s, n),
                    };
                    if v.is_none() {
                        err(&mut out, format!("default \"{}\" is not a {ty} (write default=x,y{})", d_raw.unwrap_or(""), if n == 3 { ",z" } else { "" }));
                    }
                    CustomDefault::Vec(v.unwrap_or(vec![0.0; n]))
                } else {
                    if let Some(opts) = get("options") {
                        for part in opts.split(',') {
                            let v = part.rsplit_once([':', '=']).and_then(|(_, v)| parse_f64(v.trim()));
                            match v {
                                Some(v) if part.rsplit_once([':', '=']).is_some_and(|(l, _)| !l.trim().is_empty()) => options.push(v),
                                _ => err(&mut out, format!("option \"{}\" should look like Label:value", part.trim())),
                            }
                        }
                    }
                    let d = match d_raw {
                        None => Some(options.first().copied().or(min).unwrap_or(0.0)),
                        Some(s) => num(Some(s)),
                    };
                    if d.is_none() {
                        err(&mut out, format!("default \"{}\" is not a number", d_raw.unwrap_or("")));
                    }
                    let d = d.unwrap_or(0.0);
                    CustomDefault::Num(if pty == ParamType::Int { (d + 0.5).floor() } else { d })
                }
            }
        };
        seen.push(name.clone());
        out.params.push(CustomParam { name, ty: pty, default, options });
    }
    if !has_main_image(&bare) {
        out.errors.push(ShaderError {
            line: 0,
            message: "define fn mainImage(uv: vec2f) -> vec4f — it returns the colour (display sRGB) and alpha of each pixel".into(),
        });
    }
    if let Some(i) = bare.split('\n').position(|l| l.contains("@fragment") || l.contains("@vertex") || l.contains("@compute")) {
        out.errors.push(ShaderError { line: i as u32 + 1, message: "don't write entry points; write fn mainImage(uv: vec2f) -> vec4f instead".into() });
    }
    out
}

/// `fn mainImage(<name>: vec2f) -> vec4f`.
fn has_main_image(bare: &str) -> bool {
    let compact: String = bare.chars().filter(|c| !c.is_whitespace()).collect();
    compact.match_indices("fnmainImage(").any(|(i, m)| {
        let rest = &compact[i + m.len()..];
        let Some(close) = rest.find(')') else { return false };
        let arg = &rest[..close];
        let ret = &rest[close + 1..];
        (arg.ends_with(":vec2f") || arg.ends_with(":vec2<f32>")) && (ret.starts_with("->vec4f") || ret.starts_with("->vec4<f32>"))
    })
}

/// `guardLoops` for WGSL: `for (init; cond; update)` → `(cond) && card3dGuard()`; `while cond {` →
/// `while (cond) && card3dGuard() {`; `loop {` → a check that breaks out. Only inserts text on existing
/// lines, so line numbers hold.
pub fn guard_loops(code: &str) -> String {
    let masked = strip_comments(code);
    let m = masked.as_bytes();
    let mut inserts: Vec<(usize, &str)> = Vec::new();
    let word_at = |i: usize, w: &str| {
        masked[i..].starts_with(w) && (i == 0 || !is_ident(m[i - 1] as char)) && masked[i + w.len()..].chars().next().is_none_or(|c| !is_ident(c))
    };
    let mut i = 0;
    while i < m.len() {
        if word_at(i, "for") {
            let Some(open) = masked[i + 3..].find('(').map(|k| i + 3 + k) else { break };
            let (mut depth, mut close, mut semis) = (0i32, None, Vec::new());
            for (k, &c) in m.iter().enumerate().skip(open) {
                match c {
                    b'(' => depth += 1,
                    b')' => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(k);
                            break;
                        }
                    }
                    b';' if depth == 1 => semis.push(k),
                    _ => {}
                }
            }
            let Some(_) = close else { break };
            if semis.len() == 2 {
                let (s, e) = (semis[0] + 1, semis[1]);
                if masked[s..e].trim().is_empty() {
                    inserts.push((s, " card3dGuard() "));
                } else {
                    inserts.push((s, "("));
                    inserts.push((e, ") && card3dGuard()"));
                }
            }
            i = open + 1;
        } else if word_at(i, "while") {
            // The condition runs to the `{` at depth 0.
            let s = i + 5;
            let (mut depth, mut brace) = (0i32, None);
            for (k, &c) in m.iter().enumerate().skip(s) {
                match c {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    b'{' if depth == 0 => {
                        brace = Some(k);
                        break;
                    }
                    _ => {}
                }
            }
            let Some(b) = brace else { break };
            inserts.push((s, " ("));
            inserts.push((b, ") && card3dGuard() "));
            i = b;
        } else if word_at(i, "loop") {
            if let Some(b) = masked[i + 4..].find('{').map(|k| i + 4 + k).filter(|&b| masked[i + 4..b].trim().is_empty()) {
                inserts.push((b + 1, " if (!card3dGuard()) { break; } "));
                i = b;
            }
            i += 1;
        } else {
            i += 1;
        }
    }
    inserts.sort_by_key(|x| std::cmp::Reverse(x.0));
    let mut out = code.to_string();
    for (at, text) in inserts {
        out.insert_str(at, text);
    }
    out
}

/// Whether the code uses the clock or the tilt (`animated`), and hides the artwork.
pub fn animated(code: &str) -> bool {
    let bare = strip_comments(code);
    has_word(&bare, "uTime") || has_word(&bare, "uTilt")
}

pub fn replaces_artwork(code: &str) -> bool {
    code.split('\n').any(|l| l.find("//").is_some_and(|k| l[k + 2..].trim_start().starts_with("@replaces-artwork")))
}

/// A parsed parameter as a layer uses it.
pub fn to_param(p: &CustomParam) -> crate::face_shaders::Param {
    let default = match &p.default {
        CustomDefault::Num(n) => crate::face_shaders::ParamValue::Num(*n),
        CustomDefault::Bool(b) => crate::face_shaders::ParamValue::Bool(*b),
        CustomDefault::Vec(v) => crate::face_shaders::ParamValue::Vec(v.clone()),
    };
    crate::face_shaders::Param { key: p.name.clone(), uniform: p.name.clone(), ty: p.ty, default, options: p.options.clone() }
}
