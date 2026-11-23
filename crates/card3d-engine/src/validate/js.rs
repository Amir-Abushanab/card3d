//! JavaScript's data semantics, as far as the validator needs them to give the TypeScript's results:
//! `JSON.parse` (property order with array-index keys first, the last duplicate's value at the first
//! one's place, out-of-range numbers as infinities), `JSON.stringify`, `Number.prototype.toString`,
//! `Number(string)`, `String.prototype.trim` / `\s` whitespace, and string lengths and slices in UTF-16
//! code units. Rust strings can't hold lone surrogates: wherever JavaScript would make one (a `\ud800`
//! escape, a slice through a surrogate pair) this has U+FFFD instead, as `toWellFormed()` would.

use std::fmt::Write;

#[derive(Clone, Debug, PartialEq)]
pub enum JsValue {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsValue>),
    Obj(Obj),
}

/// A plain object's own properties in JavaScript's order: array-index keys ascending, then the
/// others in insertion order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Obj(Vec<(String, JsValue)>);

/// `CanonicalNumericIndexString` restricted to array indices (0 … 2³² − 2), which objects list first.
fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || k.len() > 10 || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u64>().ok().filter(|&n| n < u32::MAX as u64).map(|n| n as u32)
}

impl Obj {
    pub fn new() -> Obj {
        Obj(Vec::new())
    }
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn has(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }
    /// `obj[key] = value` on a plain object (data properties only).
    pub fn set(&mut self, key: &str, value: JsValue) {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
            return;
        }
        match array_index(key) {
            Some(n) => {
                let at = self.0.iter().position(|(k, _)| array_index(k).is_none_or(|m| m > n)).unwrap_or(self.0.len());
                self.0.insert(at, (key.to_string(), value));
            }
            None => self.0.push((key.to_string(), value)),
        }
    }
    pub fn remove(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(k, _)| k.as_str())
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &JsValue)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }
}

impl JsValue {
    pub fn obj(&self) -> Option<&Obj> {
        if let JsValue::Obj(o) = self {
            Some(o)
        } else {
            None
        }
    }
    pub fn arr(&self) -> Option<&[JsValue]> {
        if let JsValue::Arr(a) = self {
            Some(a)
        } else {
            None
        }
    }
    pub fn str(&self) -> Option<&str> {
        if let JsValue::Str(s) = self {
            Some(s)
        } else {
            None
        }
    }
    /// A finite number (`typeof v === "number" && Number.isFinite(v)`).
    pub fn num(&self) -> Option<f64> {
        match self {
            JsValue::Num(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }
    pub fn bool(&self) -> Option<bool> {
        if let JsValue::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }
    /// `Boolean(v)`.
    pub fn truthy(&self) -> bool {
        match self {
            JsValue::Null => false,
            JsValue::Bool(b) => *b,
            JsValue::Num(n) => *n != 0.0 && !n.is_nan(),
            JsValue::Str(s) => !s.is_empty(),
            _ => true,
        }
    }
    /// Member `key` of an object (`v[key]` where `v` is a plain object; else undefined).
    pub fn at(&self, key: &str) -> Option<&JsValue> {
        self.obj()?.get(key)
    }
}

/// `v[key]` where `v` may be undefined (`None`) or not an object.
pub fn member<'a>(v: Option<&'a JsValue>, key: &str) -> Option<&'a JsValue> {
    v?.at(key)
}

/// `v == null`: undefined or null.
pub fn nullish(v: Option<&JsValue>) -> bool {
    matches!(v, None | Some(JsValue::Null))
}

// ── JSON.parse ──────────────────────────────────────────────────────────────────

/// Deepest nesting read (JavaScript has no fixed limit; designs nest a few levels).
pub const MAX_DEPTH: usize = 512;

/// `JSON.parse`. The error is a short description with the byte offset.
pub fn parse(text: &str) -> Result<JsValue, String> {
    let mut p = Parser { s: text.as_bytes(), i: 0 };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err("unexpected characters after the JSON"));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn err(&self, msg: &str) -> String {
        format!("{msg} at byte {}", self.i)
    }
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }
    fn literal(&mut self, word: &[u8], v: JsValue) -> Result<JsValue, String> {
        if self.s[self.i..].starts_with(word) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(self.err("unexpected token"))
        }
    }
    fn value(&mut self, depth: usize) -> Result<JsValue, String> {
        self.ws();
        match self.peek() {
            None => Err(self.err("unexpected end of JSON input")),
            Some(b'n') => self.literal(b"null", JsValue::Null),
            Some(b't') => self.literal(b"true", JsValue::Bool(true)),
            Some(b'f') => self.literal(b"false", JsValue::Bool(false)),
            Some(b'"') => self.string().map(JsValue::Str),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(open @ (b'[' | b'{')) => {
                if depth >= MAX_DEPTH {
                    return Err(self.err("nested too deeply"));
                }
                self.i += 1;
                let close = if open == b'[' { b']' } else { b'}' };
                let (mut arr, mut obj) = (Vec::new(), Obj::new());
                self.ws();
                if self.peek() == Some(close) {
                    self.i += 1;
                } else {
                    loop {
                        if open == b'[' {
                            arr.push(self.value(depth + 1)?);
                        } else {
                            self.ws();
                            if self.peek() != Some(b'"') {
                                return Err(self.err("expected a property name"));
                            }
                            let key = self.string()?;
                            self.ws();
                            if self.peek() != Some(b':') {
                                return Err(self.err("expected ':'"));
                            }
                            self.i += 1;
                            let v = self.value(depth + 1)?;
                            obj.set(&key, v);
                        }
                        self.ws();
                        match self.peek() {
                            Some(b',') => self.i += 1,
                            Some(c) if c == close => {
                                self.i += 1;
                                break;
                            }
                            _ => return Err(self.err("expected ',' or a closing bracket")),
                        }
                    }
                }
                Ok(if open == b'[' { JsValue::Arr(arr) } else { JsValue::Obj(obj) })
            }
            Some(_) => Err(self.err("unexpected token")),
        }
    }
    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }
    fn number(&mut self) -> Result<JsValue, String> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.err("no number after minus sign")),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if self.digits() == 0 {
                return Err(self.err("unterminated fractional number"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                return Err(self.err("exponent part is missing a number"));
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("0");
        // Correctly rounded; beyond f64's range it is ±infinity, as in JavaScript.
        Ok(JsValue::Num(text.parse().unwrap_or(f64::NAN)))
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let Some(h) = self.s.get(self.i..self.i + 4) else { return Err(self.err("bad unicode escape")) };
        let mut n = 0;
        for &c in h {
            n = n * 16 + (c as char).to_digit(16).ok_or_else(|| self.err("bad unicode escape"))?;
        }
        self.i += 4;
        Ok(n)
    }
    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let run = self.i;
            while matches!(self.peek(), Some(c) if c != b'"' && c != b'\\' && c >= 0x20) {
                self.i += 1;
            }
            out.extend_from_slice(&self.s[run..self.i]);
            match self.peek() {
                Some(b'"') => {
                    self.i += 1;
                    return String::from_utf8(out).map_err(|_| self.err("invalid UTF-8"));
                }
                Some(b'\\') => {
                    self.i += 1;
                    let Some(c) = self.peek() else { return Err(self.err("unterminated string")) };
                    self.i += 1;
                    let ch = match c {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xd800..0xdc00).contains(&hi) && self.s[self.i..].starts_with(b"\\u") {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xdc00..0xe000).contains(&lo) {
                                    char::from_u32(0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)).unwrap_or('\u{fffd}')
                                } else {
                                    // A lone high surrogate; the next escape is read on its own.
                                    self.i = save;
                                    '\u{fffd}'
                                }
                            } else {
                                char::from_u32(hi).unwrap_or('\u{fffd}')
                            }
                        }
                        _ => return Err(self.err("bad escaped character")),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                None => return Err(self.err("unterminated string")),
                Some(_) => return Err(self.err("bad control character in string")),
            }
        }
    }
}

// ── JSON.stringify ──────────────────────────────────────────────────────────────

/// `JSON.stringify(v)` (no indentation).
pub fn stringify(v: &JsValue) -> String {
    let mut out = String::new();
    write_value(&mut out, v);
    out
}

fn write_value(out: &mut String, v: &JsValue) {
    match v {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Num(n) => {
            if n.is_finite() {
                out.push_str(&number_to_string(*n))
            } else {
                out.push_str("null")
            }
        }
        JsValue::Str(s) => quote(out, s),
        JsValue::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, x);
            }
            out.push(']');
        }
        JsValue::Obj(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(out, k);
                out.push(':');
                write_value(out, x);
            }
            out.push('}');
        }
    }
}

/// `QuoteJSONString`.
pub fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ── numbers ─────────────────────────────────────────────────────────────────────

/// `Number.prototype.toString()` (radix 10): the shortest digits that round-trip, in fixed notation
/// for exponents −7 < e < 21 and exponential otherwise.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's `{:e}` is the shortest round-trip representation: d[.ddd]e<exp>.
    let e = format!("{:e}", x.abs());
    let (mantissa, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e >= 0 { format!("+{e}") } else { e.to_string() };
        if k == 1 {
            format!("{digits}e{es}")
        } else {
            format!("{}.{}e{es}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `Math.round`: the nearest integer, halves towards +∞.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `Math.min(b, Math.max(a, v))`.
pub fn clamp(v: f64, a: f64, b: f64) -> f64 {
    v.max(a).min(b)
}

/// `Number(s)` for a string (`StringToNumber`).
pub fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let mut n = 0f64;
            for &c in &b[2..] {
                let Some(d) = (c as char).to_digit(radix) else { return f64::NAN };
                n = n * radix as f64 + d as f64;
            }
            return n;
        }
    }
    let (neg, body) = match b[0] {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    if body == "Infinity" {
        return if neg { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    // StrUnsignedDecimalLiteral: digits [. digits?] | . digits, then [eE][+-]?digits.
    let bb = body.as_bytes();
    let count = |from: usize| bb[from.min(bb.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = count(0);
    let mut i = int;
    let mut frac = 0;
    if bb.get(i) == Some(&b'.') {
        frac = count(i + 1);
        i += 1 + frac;
    }
    if int + frac == 0 {
        return f64::NAN;
    }
    if matches!(bb.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bb.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let e = count(i);
        if e == 0 {
            return f64::NAN;
        }
        i += e;
    }
    if i != bb.len() {
        return f64::NAN;
    }
    let v: f64 = body.parse().unwrap_or(f64::NAN);
    if neg {
        -v
    } else {
        v
    }
}

// ── strings ─────────────────────────────────────────────────────────────────────

/// JavaScript's `WhiteSpace` and `LineTerminator` (what `trim()` removes and `\s` matches).
pub fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

/// `\w` without the `u` flag.
pub fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `.` in a regular expression without the `s` flag: anything but a line terminator.
pub fn is_dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `s.length`: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(start, end)` in UTF-16 code units (`end` past the end is the end). Half of a surrogate
/// pair becomes U+FFFD.
pub fn slice16(s: &str, start: usize, end: usize) -> String {
    let mut out = String::new();
    let mut at = 0;
    for c in s.chars() {
        let n = c.len_utf16();
        let (a, b) = (at, at + n);
        at = b;
        if b <= start || a >= end {
            continue;
        }
        if a >= start && b <= end {
            out.push(c);
        } else {
            out.push('\u{fffd}');
        }
    }
    out
}
