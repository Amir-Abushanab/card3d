//! The design JSON reader against serde_json as the oracle: the same values for the design fixtures
//! and random documents, the same accept / reject verdict for mutated input (and never a panic), and
//! the nesting cap.

use card3d_engine::json::{self, Value, MAX_DEPTH};

/// Same value: numbers compared as f64 (serde keeps integers exact; the reader reads every number as
/// f64, as JavaScript does).
fn same(a: &Value, b: &serde_json::Value) -> bool {
    match (a, b) {
        (Value::Null, serde_json::Value::Null) => true,
        (Value::Bool(x), serde_json::Value::Bool(y)) => x == y,
        (Value::Number(x), serde_json::Value::Number(y)) => {
            let y: f64 = y.to_string().parse().unwrap();
            *x == y && x.is_sign_negative() == y.is_sign_negative()
        }
        (Value::String(x), serde_json::Value::String(y)) => x == y,
        (Value::Array(x), serde_json::Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Object(x), serde_json::Value::Object(y)) => {
            // serde_json keeps the last of repeated keys, as the reader's `get` does.
            y.iter().all(|(k, v)| x.get(k).is_some_and(|a| same(a, v))) && x.iter().all(|(k, _)| y.contains_key(k))
        }
        _ => false,
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn fixtures() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../card3d-tools/designs");
    let mut out: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| (p.display().to_string(), std::fs::read_to_string(&p).unwrap()))
        .collect();
    out.sort();
    assert!(out.len() > 10, "design fixtures in {}", dir.display());
    out
}

#[test]
fn fixtures_match_serde() {
    for (name, text) in fixtures() {
        let ours = json::parse(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        let theirs: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(same(&ours, &theirs), "{name}");
    }
}

fn random_value(r: &mut Rng, depth: usize) -> serde_json::Value {
    use serde_json::Value as V;
    let pick = if depth > 5 { r.below(4) } else { r.below(6) };
    match pick {
        0 => V::Null,
        1 => V::Bool(r.below(2) == 1),
        2 => match r.below(4) {
            0 => V::from(r.next() as i64 >> r.below(64)),
            1 => V::from(r.next()),
            2 => serde_json::Number::from_f64(f64::from_bits(r.next())).map_or(V::Null, V::Number),
            _ => serde_json::Number::from_f64((r.next() % 100_000) as f64 / 1000.0 - 50.0).map_or(V::Null, V::Number),
        },
        3 => {
            let pool = ['a', 'Z', '"', '\\', '/', '\n', '\t', '\u{1}', '\u{7f}', 'é', '€', '😀', '\u{2028}', ' '];
            V::String((0..r.below(12)).map(|_| pool[r.below(pool.len())]).collect())
        }
        4 => V::Array((0..r.below(5)).map(|_| random_value(r, depth + 1)).collect()),
        _ => V::Object((0..r.below(5)).map(|i| (format!("k{}", (i + r.below(3)) % 4), random_value(r, depth + 1))).collect()),
    }
}

#[test]
fn random_documents_match_serde() {
    let mut r = Rng(0x9e3779b97f4a7c15);
    for _ in 0..20_000 {
        let v = random_value(&mut r, 0);
        for text in [serde_json::to_string(&v).unwrap(), serde_json::to_string_pretty(&v).unwrap()] {
            let ours = json::parse(&text).unwrap_or_else(|e| panic!("{text}: {e}"));
            assert!(same(&ours, &v), "{text}");
        }
    }
}

/// Mutations of the fixtures: the reader accepts exactly what serde_json accepts (and never panics).
#[test]
fn mutated_input_agrees_with_serde() {
    let tokens =
        ["", "\"", "\\", "\\u", "\\ud800", "\\udc00", "{", "}", "[", "]", ",", ":", "-", "0", "01", ".", "e", "E+", "1e999", "null", "tru", " ", "\u{1}", "é"];
    let docs: Vec<String> = fixtures().into_iter().map(|(_, t)| t).collect();
    let mut r = Rng(42);
    let mut rejected = 0;
    for _ in 0..30_000 {
        let doc = &docs[r.below(docs.len())];
        let chars: Vec<char> = doc.chars().collect();
        let mut out: Vec<char> = chars;
        for _ in 0..1 + r.below(3) {
            let at = r.below(out.len() + 1);
            match r.below(3) {
                0 if at < out.len() => {
                    out.remove(at);
                }
                1 if at < out.len() => {
                    out.drain(at..(at + 1 + r.below(8)).min(out.len()));
                }
                _ => {
                    let t = tokens[r.below(tokens.len())];
                    out.splice(at..at, t.chars());
                }
            }
        }
        let text: String = out.into_iter().collect();
        let ours = json::parse(&text);
        let theirs = serde_json::from_str::<serde_json::Value>(&text);
        assert_eq!(ours.is_ok(), theirs.is_ok(), "verdicts differ ({:?} vs {:?}) for:\n{text}", ours.err(), theirs.err());
        if let (Ok(a), Ok(b)) = (&ours, &theirs) {
            assert!(same(a, b), "{text}");
        } else {
            rejected += 1;
        }
    }
    assert!(rejected > 5_000, "the mutations should break most documents ({rejected})");
}

#[test]
fn edge_cases() {
    for ok in ["0", "-0", "1e5", "-1.5E-3", "\"\\ud83d\\ude00\"", " [ ] ", "{\"a\":{}}", "\"\u{2028}\""] {
        let v = json::parse(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        assert!(same(&v, &serde_json::from_str(ok).unwrap()), "{ok}");
    }
    for bad in [
        "",
        "01",
        "1.",
        ".5",
        "+1",
        "1e",
        "-",
        "NaN",
        "Infinity",
        "1e400",
        "[1,]",
        "{\"a\":1,}",
        "{a:1}",
        "'a'",
        "\"\\x\"",
        "\"\\ud800\"",
        "\"\\udc00\"",
        "\"a\nb\"",
        "[] []",
        "nul",
    ] {
        assert!(json::parse(bad).is_err(), "{bad:?} should be rejected");
    }
    // Repeated keys: the last wins.
    assert_eq!(json::parse(r#"{"a":1,"a":2}"#).unwrap().get("a"), Some(&Value::Number(2.0)));
    // `get` treats null as missing.
    assert_eq!(json::parse(r#"{"a":null}"#).unwrap().get("a"), None);
}

#[test]
fn nesting_is_capped() {
    let nest = |n: usize| "[".repeat(n) + &"]".repeat(n);
    assert!(json::parse(&nest(MAX_DEPTH)).is_ok());
    assert_eq!(json::parse(&nest(MAX_DEPTH + 1)).unwrap_err().msg, "nested too deeply");
    // Far past the cap: an error, not a stack overflow.
    assert!(json::parse(&nest(1_000_000)).is_err());
    assert!(json::parse(&"{\"a\":".repeat(100_000)).is_err());
}

/// `json::parse_f64` (face shader annotations) accepts exactly what `str::parse::<f64>` does, with the
/// same value.
#[test]
fn parse_f64_matches_str_parse() {
    let same = |s: &str| {
        let ours = json::parse_f64(s);
        let std = s.parse::<f64>().ok();
        assert_eq!(ours.map(f64::to_bits), std.map(f64::to_bits), "{s:?}");
    };
    for s in [
        "",
        "+",
        "-",
        ".",
        "1",
        "-1",
        "+1",
        "1.",
        ".5",
        "-.5",
        "1.5e3",
        "1e",
        "1e+",
        "1e-2",
        "1E2",
        "e3",
        ".e3",
        "1.e3",
        "0x10",
        "1_0",
        " 1",
        "1 ",
        "inf",
        "-INF",
        "+Infinity",
        "infinit",
        "NaN",
        "-nan",
        "nan1",
        "1.2.3",
        "--1",
        "1e5.5",
        "00012",
        "1e400",
        "-1e-400",
    ] {
        same(s);
    }
    let alphabet = b"0123456789.eE+-infatyINF x";
    let mut r = Rng(7);
    for _ in 0..50_000 {
        let n = r.below(8);
        let s: String = (0..n).map(|_| alphabet[r.below(alphabet.len())] as char).collect();
        same(&s);
    }
}
