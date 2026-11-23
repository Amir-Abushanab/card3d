//! `parseCustomShader` (packages/core/src/shaders/custom-parse.ts) to the letter: the parameters a
//! custom face layer's annotations declare, and the WGSL annotation errors with their lines. The
//! renderer's own reader (`crate::face_custom::parse`) is close but not identical; this one follows the
//! TypeScript's regular expressions, `Number()` and messages, so validation gives the same results.
//! Labels, descriptions, steps and defaults aren't kept: validation only needs keys, types, options
//! and errors.

use super::js::{is_dot, is_word, is_ws, number_to_string, string_to_number, trim};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParamType {
    Float,
    Int,
    Bool,
    Color,
    Vec2,
    Vec3,
    /// A GLSL uniform whose type names an `Object.prototype` member (`PARAM_TYPES[type]` is then a
    /// function, which the TypeScript takes as a type no value coerces to).
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Param {
    pub key: String,
    pub ty: ParamType,
    /// `options[].value` (int / float selects); NaN for an option whose value isn't a number.
    pub options: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    /// 1-based line of the code; 0 when it isn't attributable to a line.
    pub line: usize,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parse {
    pub params: Vec<Param>,
    pub errors: Vec<Error>,
}

/// `Object.prototype`'s property names: an object literal used as a lookup table "has" these.
pub(crate) const PROTO_NAMES: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

fn reserved(name: &str) -> bool {
    name == "card3dLoopGuard" || name == "card3dGuard" || super::catalog::get().prelude.iter().any(|p| p == name)
}

/// `stripComments`: block comments (`/\*[\s\S]*?\*\//g`), then line comments (`/\/\/[^\n]*/g`), each
/// replaced by a space per UTF-16 unit, newlines kept.
pub fn strip_comments(code: &str) -> String {
    let blank = |s: &str, out: &mut String| {
        for c in s.chars() {
            if c == '\n' {
                out.push('\n');
            } else {
                for _ in 0..c.len_utf16() {
                    out.push(' ');
                }
            }
        }
    };
    let mut pass1 = String::with_capacity(code.len());
    let mut rest = code;
    while let Some(open) = rest.find("/*") {
        let Some(close) = rest[open + 2..].find("*/") else { break };
        let end = open + 2 + close + 2;
        pass1.push_str(&rest[..open]);
        blank(&rest[open..end], &mut pass1);
        rest = &rest[end..];
    }
    pass1.push_str(rest);
    let mut out = String::with_capacity(pass1.len());
    let mut rest = pass1.as_str();
    while let Some(open) = rest.find("//") {
        let end = rest[open..].find('\n').map_or(rest.len(), |e| open + e);
        out.push_str(&rest[..open]);
        blank(&rest[open..end], &mut out);
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn skip_ws(s: &str) -> &str {
    s.trim_start_matches(is_ws)
}

/// `\w+` at the start of `s`: (the word, the rest).
fn word(s: &str) -> Option<(&str, &str)> {
    let n = s.find(|c: char| !is_word(c)).unwrap_or(s.len());
    (n > 0).then(|| (&s[..n], &s[n..]))
}

/// `\s+` at the start of `s`.
fn ws1(s: &str) -> Option<&str> {
    let t = skip_ws(s);
    (t.len() < s.len()).then_some(t)
}

/// `/^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*;/`: (type, name, array).
fn glsl_declaration(line: &str) -> Option<(String, String, bool)> {
    let s = ws1(skip_ws(line).strip_prefix("uniform")?)?;
    let tail = |s: &str| -> Option<(String, String, bool)> {
        let (ty, s) = word(s)?;
        let (name, s) = word(ws1(s)?)?;
        let s = skip_ws(s);
        let (array, s) = match s.strip_prefix('[') {
            Some(a) => (true, &a[a.find(']')? + 1..]),
            None => (false, s),
        };
        skip_ws(s).starts_with(';').then(|| (ty.to_string(), name.to_string(), array))
    };
    for q in ["lowp", "mediump", "highp"] {
        if let Some(after) = s.strip_prefix(q).and_then(ws1) {
            if let Some(m) = tail(after) {
                return Some(m);
            }
        }
    }
    tail(s)
}

/// `/^\s*var\s*<\s*private\s*>\s*(\w+)\s*:\s*([^;=]+?)\s*;/`: (name, type with whitespace removed).
fn wgsl_declaration(line: &str) -> Option<(String, String)> {
    let s = skip_ws(skip_ws(line).strip_prefix("var")?).strip_prefix('<')?;
    let s = skip_ws(skip_ws(s).strip_prefix("private")?).strip_prefix('>')?;
    let (name, s) = word(skip_ws(s))?;
    let s = skip_ws(s).strip_prefix(':')?;
    let end = s.find([';', '='])?;
    if !s[end..].starts_with(';') || end == 0 {
        return None;
    }
    Some((name.to_string(), s[..end].chars().filter(|&c| !is_ws(c)).collect()))
}

/// `/\/\/\s*@(param|color)\b(.*)$/.exec(raw)`: (kind, the rest of the line).
fn annotation(raw: &str) -> Option<(&'static str, &str)> {
    let mut from = 0;
    while let Some(i) = raw[from..].find("//") {
        let at = from + i;
        from = at + 1;
        let Some(s) = skip_ws(&raw[at + 2..]).strip_prefix('@') else { continue };
        let Some((kind, rest)) = [("param", "param"), ("color", "color")].iter().find_map(|(k, name)| s.strip_prefix(k).map(|r| (*name, r))) else { continue };
        if rest.chars().next().is_some_and(is_word) || !rest.chars().all(is_dot) {
            continue;
        }
        return Some((kind, rest));
    }
    None
}

/// `tokenize`: positional words and named `key=value` pairs (keys lower-cased; the last one wins).
fn tokenize(s: &str) -> (Vec<String>, Vec<(String, String)>) {
    let c: Vec<char> = s.chars().collect();
    let (mut positional, mut named) = (Vec::<String>::new(), Vec::<(String, String)>::new());
    let text = |a: usize, b: usize| c[a..b].iter().collect::<String>();
    let non_ws_run = |p: usize| (p..c.len()).find(|&j| is_ws(c[j])).unwrap_or(c.len());
    // A quoted string starting at `p` (its closing quote's index).
    let quoted = |p: usize, q: char| (c.get(p) == Some(&q)).then(|| (p + 1..c.len()).find(|&j| c[j] == q)).flatten();
    let mut p = 0;
    while p < c.len() {
        // Alternative 1: key \s* = \s* ("…" | '…' | \S+).
        if c[p].is_ascii_alphabetic() || c[p] == '_' {
            let key_end = (p..c.len()).find(|&j| !is_word(c[j])).unwrap_or(c.len());
            let eq = (key_end..c.len()).find(|&j| !is_ws(c[j]));
            if let Some(eq) = eq.filter(|&j| c[j] == '=') {
                let v = (eq + 1..c.len()).find(|&j| !is_ws(c[j]));
                if let Some(v) = v {
                    let key = text(p, key_end).to_ascii_lowercase();
                    let (value, end) = if let Some(close) = quoted(v, '"') {
                        (text(v + 1, close), close + 1)
                    } else if let Some(close) = quoted(v, '\'') {
                        (text(v + 1, close), close + 1)
                    } else {
                        let e = non_ws_run(v);
                        (text(v, e), e)
                    };
                    if key != "__proto__" {
                        match named.iter_mut().find(|(k, _)| *k == key) {
                            Some(slot) => slot.1 = value,
                            None => named.push((key, value)),
                        }
                    }
                    p = end;
                    continue;
                }
            }
        }
        // Alternative 2: "…" | \S+.
        if let Some(close) = quoted(p, '"') {
            positional.push(text(p + 1, close));
            p = close + 1;
        } else if !is_ws(c[p]) {
            let e = non_ws_run(p);
            positional.push(text(p, e));
            p = e;
        } else {
            p += 1;
        }
    }
    (positional, named)
}

/// `num`: `Number(s)` when finite.
fn num(s: Option<&str>) -> Option<f64> {
    s.map(string_to_number).filter(|n| n.is_finite())
}

/// `parseVector`.
fn parse_vector(s: &str, n: usize) -> Option<Vec<f64>> {
    let mut t = s;
    if t.starts_with(['(', '[']) {
        t = &t[1..];
    }
    if t.ends_with([')', ']']) && !(t.len() < s.len() && t.is_empty()) {
        t = &t[..t.len() - 1];
    }
    let parts: Vec<f64> = t.split(|c: char| c == ',' || is_ws(c)).filter(|p| !p.is_empty()).map(string_to_number).collect();
    if parts.len() == 1 && parts[0].is_finite() {
        return Some(vec![parts[0]; n]);
    }
    (parts.len() == n && parts.iter().all(|v| v.is_finite())).then_some(parts)
}

/// `/^\s*([^:=]+?)\s*[:=]\s*(-?[\d.]+)\s*$/`: an option's value, when the part matches.
fn option_value(part: &str) -> Option<f64> {
    let sep = part.find([':', '='])?;
    if sep == 0 {
        return None;
    }
    let v = trim(&part[sep + 1..]);
    let digits = v.strip_prefix('-').unwrap_or(v);
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit() || b == b'.')).then(|| string_to_number(v))
}

/// The rules of one `@param` annotation on a uniform of GLSL type `ty` (`float`, `int`, `bool`, `vec2`,
/// `vec3`, or another word): the param and its errors.
fn param_rules(name: &str, ty: &str, ptype: ParamType, rest: &str, errors: &mut Vec<String>) -> Param {
    let (positional, named) = tokenize(rest);
    let get = |k: &str| named.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let pos = |i: usize| positional.get(i).map(String::as_str);
    let mut options = Vec::new();
    if ptype == ParamType::Bool {
        let d = get("default").or(pos(0)).unwrap_or("false").to_lowercase();
        if !matches!(d.as_str(), "true" | "false" | "1" | "0") {
            errors.push(format!("bool default must be true or false (got \"{d}\")"));
        }
    } else {
        let (min_s, max_s) = (get("min").or(pos(0)), get("max").or(pos(1)));
        let (min, max) = (num(min_s), num(max_s));
        for (k, v) in [("min", min_s), ("max", max_s)] {
            if let Some(v) = v.filter(|v| num(Some(v)).is_none()) {
                errors.push(format!("{k} \"{v}\" is not a number"));
            }
        }
        if let (Some(a), Some(b)) = (min, max) {
            if a > b {
                errors.push(format!("min {} is greater than max {}", number_to_string(a), number_to_string(b)));
            }
        }
        let d_raw = get("default").or(pos(2));
        if matches!(ptype, ParamType::Vec2 | ParamType::Vec3) {
            let n = if ptype == ParamType::Vec2 { 2 } else { 3 };
            let ok = d_raw.is_none_or(|d| parse_vector(d, n).is_some());
            if !ok {
                errors.push(format!("default \"{}\" is not a {ty} (write default=x,y{})", d_raw.unwrap_or(""), if n == 3 { ",z" } else { "" }));
            }
        } else {
            if let Some(opts) = get("options") {
                for part in opts.split(',') {
                    match option_value(part) {
                        Some(v) => options.push(v),
                        None => errors.push(format!("option \"{}\" should look like Label:value", trim(part))),
                    }
                }
            }
            if let Some(d) = d_raw.filter(|d| num(Some(d)).is_none()) {
                errors.push(format!("default \"{d}\" is not a number"));
            }
        }
    }
    Param { key: name.to_string(), ty: ptype, options }
}

/// `parseCustomShader(code, language)`.
pub fn parse(code: &str, wgsl: bool) -> Parse {
    if wgsl {
        parse_wgsl(code)
    } else {
        parse_glsl(code)
    }
}

/// The GLSL form (from the three.js era): only its parameters are used (to keep a GLSL layer's values).
fn parse_glsl(code: &str) -> Parse {
    let mut out = Parse::default();
    let bare = strip_comments(code);
    let mut seen: Vec<String> = Vec::new();
    for (i, (raw, stripped)) in code.split('\n').zip(bare.split('\n')).enumerate() {
        let line = i + 1;
        let Some((ty, name, array)) = glsl_declaration(stripped) else { continue };
        if reserved(&name) {
            out.errors.push(Error { line, message: format!("\"{name}\" is provided by the face shader prelude; remove this declaration") });
            continue;
        }
        let Some((kind, rest)) = annotation(raw) else { continue };
        if array || seen.contains(&name) {
            continue;
        }
        if kind == "color" {
            if ty == "vec3" {
                seen.push(name.clone());
                out.params.push(Param { key: name, ty: ParamType::Color, options: vec![] });
            }
            continue;
        }
        let ptype = match ty.as_str() {
            "float" => ParamType::Float,
            "int" => ParamType::Int,
            "bool" => ParamType::Bool,
            "vec2" => ParamType::Vec2,
            "vec3" => ParamType::Vec3,
            t if PROTO_NAMES.contains(&t) => ParamType::Other,
            _ => continue,
        };
        let mut errors = Vec::new();
        let p = param_rules(&name, &ty, ptype, rest, &mut errors);
        seen.push(name);
        out.params.push(p);
    }
    out
}

fn wgsl_type(ty: &str) -> Option<ParamType> {
    match ty {
        "f32" => Some(ParamType::Float),
        "i32" => Some(ParamType::Int),
        "bool" => Some(ParamType::Bool),
        "vec2f" | "vec2<f32>" => Some(ParamType::Vec2),
        "vec3f" | "vec3<f32>" => Some(ParamType::Vec3),
        _ => None,
    }
}

/// `\bfn\s+mainImage\s*\(\s*\w+\s*:\s*vec2(?:f|<\s*f32\s*>)\s*\)\s*->\s*vec4(?:f|<\s*f32\s*>)` anywhere.
fn has_main_image(s: &str) -> bool {
    fn f32_suffix(s: &str) -> Option<&str> {
        if let Some(r) = s.strip_prefix('f') {
            return Some(r);
        }
        skip_ws(skip_ws(s.strip_prefix('<')?).strip_prefix("f32")?).strip_prefix('>')
    }
    let at = |s: &str| -> Option<()> {
        let s = skip_ws(ws1(s.strip_prefix("fn")?)?.strip_prefix("mainImage")?).strip_prefix('(')?;
        let (_, s) = word(skip_ws(s))?;
        let s = f32_suffix(skip_ws(skip_ws(s).strip_prefix(':')?).strip_prefix("vec2")?)?;
        let s = skip_ws(skip_ws(skip_ws(s).strip_prefix(')')?).strip_prefix("->")?).strip_prefix("vec4")?;
        f32_suffix(s).map(|_| ())
    };
    s.match_indices("fn").any(|(i, _)| !s[..i].chars().next_back().is_some_and(is_word) && at(&s[i..]).is_some())
}

/// `/@(fragment|vertex|compute)\b/`.
fn entry_point(line: &str) -> bool {
    line.match_indices('@')
        .any(|(i, _)| ["fragment", "vertex", "compute"].iter().any(|k| line[i + 1..].strip_prefix(k).is_some_and(|r| !r.chars().next().is_some_and(is_word))))
}

fn parse_wgsl(code: &str) -> Parse {
    let mut out = Parse::default();
    let bare = strip_comments(code);
    let mut seen: Vec<String> = Vec::new();
    for (i, (raw, stripped)) in code.split('\n').zip(bare.split('\n')).enumerate() {
        let line = i + 1;
        let mut err = |m: String| out.errors.push(Error { line, message: m });
        let Some((name, ty)) = wgsl_declaration(stripped) else { continue };
        if reserved(&name) || name == "uSource" {
            err(format!("\"{name}\" is provided by the face shader prelude; remove this declaration"));
            continue;
        }
        let Some((kind, rest)) = annotation(raw) else { continue };
        if seen.contains(&name) {
            err(format!("\"{name}\" is declared twice"));
            continue;
        }
        if kind == "color" {
            if wgsl_type(&ty) != Some(ParamType::Vec3) {
                err(format!("@color needs a vec3f declaration (\"{name}\" is {ty})"));
                continue;
            }
            let (positional, named) = tokenize(rest);
            let given = named.iter().find(|(k, _)| k == "default").map(|(_, v)| v.as_str()).or(positional.first().map(String::as_str)).unwrap_or("#ffffff");
            if !is_shader_color(given) {
                err(format!("@color default \"{given}\" is not a #rrggbb colour"));
            }
            seen.push(name.clone());
            out.params.push(Param { key: name, ty: ParamType::Color, options: vec![] });
            continue;
        }
        let ptype = match wgsl_type(&ty) {
            Some(t) => t,
            // `WGSL_TYPES[type]` is a function or `Object.prototype` here: the GLSL line built from it
            // doesn't parse, so the declaration is skipped without an error.
            None if PROTO_NAMES.contains(&ty.as_str()) => continue,
            None => {
                err(format!("@param supports f32, i32, bool, vec2f and vec3f (\"{name}\" is {ty}); use @color for colours"));
                continue;
            }
        };
        let glsl = match ptype {
            ParamType::Float => "float",
            ParamType::Int => "int",
            ParamType::Bool => "bool",
            ParamType::Vec2 => "vec2",
            _ => "vec3",
        };
        let mut errors = Vec::new();
        let p = param_rules(&name, glsl, ptype, rest, &mut errors);
        for m in errors {
            err(m);
        }
        seen.push(name);
        out.params.push(p);
    }
    if !has_main_image(&bare) {
        out.errors
            .push(Error {
                line: 0, message: "define fn mainImage(uv: vec2f) -> vec4f — it returns the colour (display sRGB) and alpha of each pixel".into()
            });
    }
    if let Some(i) = bare.split('\n').position(entry_point) {
        out.errors.push(Error { line: i + 1, message: "don't write entry points; write fn mainImage(uv: vec2f) -> vec4f instead".into() });
    }
    out
}

/// `parseShaderColor` for a string: `#?rrggbb` or `#?rgb` after trimming.
pub fn is_shader_color(v: &str) -> bool {
    shader_color(v).is_some()
}

/// `parseShaderColor(string)`: 0..1 channels.
pub fn shader_color(v: &str) -> Option<[f64; 3]> {
    let s = trim(v);
    let h = s.strip_prefix('#').unwrap_or(s);
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let d = |i: usize| (h.as_bytes()[i] as char).to_digit(16).unwrap_or(0) as f64;
    match h.len() {
        6 => Some([(d(0) * 16.0 + d(1)) / 255.0, (d(2) * 16.0 + d(3)) / 255.0, (d(4) * 16.0 + d(5)) / 255.0]),
        3 => Some([d(0) * 17.0 / 255.0, d(1) * 17.0 / 255.0, d(2) * 17.0 / 255.0]),
        _ => None,
    }
}
