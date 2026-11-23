//! A small JSON reader for the design input, so the web build doesn't carry serde (about a tenth of
//! the WebGPU wasm). Strict RFC 8259 syntax; nesting is capped at `MAX_DEPTH` so hostile input
//! can't exhaust the stack, and the reader never panics on bad input (tested against serde_json in
//! tests/json.rs, which also feeds it mutated and random bytes). Duplicate keys: the last one wins,
//! as in `JSON.parse`.

use std::fmt;

/// Deepest nesting of arrays and objects accepted. Designs nest four levels.
pub const MAX_DEPTH: usize = 128;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Map),
}

/// An object's members in document order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Map(pub Vec<(String, Value)>);

impl Map {
    /// The member `key` (the last one, if repeated).
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }
}

impl Value {
    /// Member `key` of an object; `None` for anything else, a missing key or `null`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?.get(key).filter(|v| !v.is_null())
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Value::String(s) = self {
            Some(s)
        } else {
            None
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if let Value::Number(n) = self {
            Some(*n)
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Value::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }
    pub fn as_array(&self) -> Option<&[Value]> {
        if let Value::Array(a) = self {
            Some(a)
        } else {
            None
        }
    }
    pub fn as_object(&self) -> Option<&Map> {
        if let Value::Object(m) = self {
            Some(m)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Error {
    /// Byte offset of the problem.
    pub pos: usize,
    pub msg: &'static str,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.msg, self.pos)
    }
}

/// Parses one JSON document (surrounding whitespace allowed).
pub fn parse(text: &str) -> Result<Value, Error> {
    let mut p = Parser { s: text.as_bytes(), i: 0 };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return p.err("trailing characters");
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn err<T>(&self, msg: &'static str) -> Result<T, Error> {
        Err(Error { pos: self.i, msg })
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn literal(&mut self, word: &[u8], v: Value) -> Result<Value, Error> {
        if self.s[self.i..].starts_with(word) {
            self.i += word.len();
            Ok(v)
        } else {
            self.err("expected a value")
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, Error> {
        self.ws();
        match self.peek() {
            None => self.err("unexpected end"),
            Some(b'n') => self.literal(b"null", Value::Null),
            Some(b't') => self.literal(b"true", Value::Bool(true)),
            Some(b'f') => self.literal(b"false", Value::Bool(false)),
            Some(b'"') => self.string().map(Value::String),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(b'[') => {
                if depth >= MAX_DEPTH {
                    return self.err("nested too deeply");
                }
                self.i += 1;
                let mut out = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(Value::Array(out));
                }
                loop {
                    out.push(self.value(depth + 1)?);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Array(out));
                        }
                        _ => return self.err("expected ',' or ']'"),
                    }
                }
            }
            Some(b'{') => {
                if depth >= MAX_DEPTH {
                    return self.err("nested too deeply");
                }
                self.i += 1;
                let mut out = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(Value::Object(Map(out)));
                }
                loop {
                    self.ws();
                    if self.peek() != Some(b'"') {
                        return self.err("expected a key");
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.peek() != Some(b':') {
                        return self.err("expected ':'");
                    }
                    self.i += 1;
                    out.push((key, self.value(depth + 1)?));
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Object(Map(out)));
                        }
                        _ => return self.err("expected ',' or '}'"),
                    }
                }
            }
            Some(_) => self.err("expected a value"),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }

    /// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, read by the standard library's correctly
    /// rounded float parser. Values beyond f64's range are an error.
    fn number(&mut self) -> Result<Value, Error> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return self.err("invalid number"),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if self.digits() == 0 {
                return self.err("invalid number");
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                return self.err("invalid number");
            }
        }
        // The slice is ASCII digits and signs, so it is valid UTF-8.
        let text = std::str::from_utf8(&self.s[start..self.i]).unwrap_or("");
        match number(text) {
            n if n.is_finite() => Ok(Value::Number(n)),
            _ => Err(Error { pos: start, msg: "number out of range" }),
        }
    }

    fn hex4(&mut self) -> Result<u32, Error> {
        let Some(h) = self.s.get(self.i..self.i + 4) else { return self.err("invalid escape") };
        let mut n = 0;
        for &c in h {
            let d = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return self.err("invalid escape"),
            };
            n = n * 16 + d as u32;
        }
        self.i += 4;
        Ok(n)
    }

    /// A string starting at the opening quote. The input is a `&str`, so runs between escapes are
    /// valid UTF-8 already; control characters must be escaped; lone surrogates are an error.
    fn string(&mut self) -> Result<String, Error> {
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
                    // Built from whole UTF-8 sequences and encoded chars only.
                    return String::from_utf8(out).or_else(|_| self.err("invalid string"));
                }
                Some(b'\\') => {
                    self.i += 1;
                    let Some(c) = self.peek() else { return self.err("unexpected end") };
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
                            let code = if (0xd800..0xdc00).contains(&hi) {
                                if !self.s[self.i..].starts_with(b"\\u") {
                                    return self.err("lone surrogate");
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&lo) {
                                    return self.err("lone surrogate");
                                }
                                0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                            } else {
                                hi
                            };
                            match char::from_u32(code) {
                                Some(ch) => ch,
                                None => return self.err("lone surrogate"),
                            }
                        }
                        _ => return self.err("invalid escape"),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                None => return self.err("unterminated string"),
                Some(_) => return self.err("control character in string"),
            }
        }
    }
}

/// `str::parse::<f64>`: the same syntax (an optional sign, then decimal digits with an optional
/// fraction and exponent, or `inf` / `infinity` / `nan` in any case) and value, but on the web without
/// core's float parser (see `number`).
pub fn parse_f64(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let neg = b.first() == Some(&b'-');
    let body = if matches!(b.first(), Some(b'+' | b'-')) { &b[1..] } else { b };
    if body.eq_ignore_ascii_case(b"inf") || body.eq_ignore_ascii_case(b"infinity") {
        return Some(if neg { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    if body.eq_ignore_ascii_case(b"nan") {
        return Some(if neg { -f64::NAN } else { f64::NAN });
    }
    let digits = |from: usize| body[from.min(body.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits(0);
    let mut i = int;
    let mut frac = 0;
    if body.get(i) == Some(&b'.') {
        frac = digits(i + 1);
        i += 1 + frac;
    }
    if int + frac == 0 {
        return None;
    }
    if matches!(body.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(body.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let e = digits(i);
        if e == 0 {
            return None;
        }
        i += e;
    }
    (i == body.len()).then(|| number(s))
}

/// The value of a number's text (valid syntax), correctly rounded; infinite when out of range.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn number(text: &str) -> f64 {
    text.parse().unwrap_or(f64::NAN)
}

/// On the web the browser parses numbers (`parseFloat`, provided by card3d-web): core's float parser
/// and its tables would cost the main module about 15 KB gzipped. Both round correctly.
#[cfg(target_arch = "wasm32")]
pub(crate) fn number(text: &str) -> f64 {
    #[allow(unsafe_code, reason = "card3d-web defines it, a safe fn with this signature; the link fails without it")]
    unsafe extern "Rust" {
        safe fn card3d_parse_number(text: &str) -> f64;
    }
    card3d_parse_number(text)
}
