//! Effect and add-on parameters (packages/core/src/effects/params.ts): each effect declares its
//! table (`EffectParam`), and `resolve` reads a design's values against it, falling back to the
//! defaults (`resolveEffectParams`).

use crate::json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Float {
        min: f64,
        max: f64,
    },
    Bool,
    Color,
    /// One of these values.
    Select(&'static [&'static str]),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Default {
    Num(f64),
    Bool(bool),
    Str(&'static str),
}

/// One parameter (`EffectParamSpec`). `optional`: no valid value resolves to `None`.
#[derive(Clone, Copy, Debug)]
pub struct EffectParam {
    pub key: &'static str,
    pub kind: Kind,
    pub default: Default,
    pub optional: bool,
}

impl EffectParam {
    pub const fn new(key: &'static str, kind: Kind, default: Default) -> Self {
        EffectParam { key, kind, default, optional: false }
    }
    pub const fn optional(self) -> Self {
        EffectParam { optional: true, ..self }
    }
}

/// A resolved value.
#[derive(Clone, Debug, PartialEq)]
pub enum ParamValue {
    Num(f64),
    Bool(bool),
    /// A colour ("#rrggbb", lower case) or a select value.
    Str(String),
}

/// Every parameter of a table, resolved (`ResolvedEffectParams`).
#[derive(Clone, Debug, PartialEq)]
pub struct Params(Vec<(&'static str, Option<ParamValue>)>);

impl Params {
    pub fn get(&self, key: &str) -> Option<&ParamValue> {
        self.0.iter().find(|(k, _)| *k == key).and_then(|(_, v)| v.as_ref())
    }
    pub fn num(&self, key: &str) -> f64 {
        match self.get(key) {
            Some(ParamValue::Num(n)) => *n,
            _ => 0.0,
        }
    }
    pub fn bool(&self, key: &str) -> bool {
        matches!(self.get(key), Some(ParamValue::Bool(true)))
    }
    pub fn str(&self, key: &str) -> &str {
        match self.get(key) {
            Some(ParamValue::Str(s)) => s,
            _ => "",
        }
    }
    /// True when `key` holds its default (`isDefaultParam`; colours compare case-insensitively, which
    /// normalisation already did).
    pub fn is_default(&self, table: &[EffectParam], key: &str) -> bool {
        let Some(spec) = table.iter().find(|p| p.key == key) else { return false };
        match (self.get(key), spec.default) {
            (Some(ParamValue::Num(n)), Default::Num(d)) => *n == d,
            (Some(ParamValue::Bool(b)), Default::Bool(d)) => *b == d,
            (Some(ParamValue::Str(s)), Default::Str(d)) => match spec.kind {
                Kind::Color => normalize_hex(d).as_deref() == Some(s.as_str()),
                _ => s == d,
            },
            _ => false,
        }
    }
}

/// "#rgb" / "#rrggbb" (the "#" optional, any case) → "#rrggbb" lower case (`normalizeHexColor`).
pub fn normalize_hex(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    let h = s.strip_prefix('#').unwrap_or(&s);
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match h.len() {
        6 => Some(format!("#{h}")),
        3 => Some(h.chars().fold(String::from("#"), |mut o, c| {
            o.push(c);
            o.push(c);
            o
        })),
        _ => None,
    }
}

/// `coerceEffectParam`: the value when it fits `spec`.
fn coerce(spec: &EffectParam, v: &Value) -> Option<ParamValue> {
    match spec.kind {
        Kind::Float { min, max } => {
            let n = v.as_f64().filter(|n| n.is_finite())?;
            Some(ParamValue::Num(n.max(min).min(max)))
        }
        Kind::Bool => v.as_bool().map(ParamValue::Bool),
        Kind::Color => v.as_str().and_then(normalize_hex).map(ParamValue::Str),
        Kind::Select(options) => v.as_str().filter(|s| options.contains(s)).map(|s| ParamValue::Str(s.into())),
    }
}

fn default_value(spec: &EffectParam) -> ParamValue {
    match spec.default {
        Default::Num(n) => ParamValue::Num(n),
        Default::Bool(b) => ParamValue::Bool(b),
        Default::Str(s) => ParamValue::Str(match spec.kind {
            Kind::Color => normalize_hex(s).unwrap_or_else(|| s.into()),
            _ => s.into(),
        }),
    }
}

/// `resolveEffectParams`: every parameter of `table`, from `values` where valid, else its default.
pub fn resolve(table: &[EffectParam], values: Option<&Map>) -> Params {
    Params(
        table
            .iter()
            .map(|spec| {
                let given = values.and_then(|m| m.get(spec.key)).and_then(|v| coerce(spec, v));
                (spec.key, given.or_else(|| (!spec.optional).then(|| default_value(spec))))
            })
            .collect(),
    )
}
