//! The design validator against the TypeScript: tests/data/validate-cases.json holds `lintDesign`'s
//! results (the design's FNV-1a hash, the errors and warnings) for every fixture in
//! crates/card3d-tools/designs/, hand-written edge cases and a sample of mutated designs, written by
//! `node crates/card3d-tools/validate-compare.ts --write-cases` (which compares thousands more).
#![cfg(feature = "validate")]

use card3d_engine::validate::{self, js, JsValue};

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn issues(v: Option<&JsValue>) -> Vec<(String, String)> {
    v.and_then(JsValue::arr)
        .unwrap_or(&[])
        .iter()
        .map(|i| (i.at("path").and_then(JsValue::str).unwrap_or("").to_string(), i.at("message").and_then(JsValue::str).unwrap_or("").to_string()))
        .collect()
}

#[test]
fn matches_the_typescript() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../card3d-tools/designs/");
    let cases = js::parse(include_str!("data/validate-cases.json")).expect("cases");
    let cases = cases.arr().expect("an array");
    assert!(cases.len() > 200, "{} cases", cases.len());
    for case in cases {
        let (name, text) = match (case.at("fixture").and_then(JsValue::str), case.at("input").and_then(JsValue::str)) {
            (Some(f), _) => (f.to_string(), std::fs::read_to_string(format!("{root}{f}")).expect("fixture")),
            (_, Some(t)) => (t.chars().take(120).collect(), t.to_string()),
            _ => panic!("a case without input"),
        };
        let l = validate::lint(&text);
        let design = l.design.as_ref().map(|d| fnv(&js::stringify(d)));
        assert_eq!(design.as_deref(), case.at("design").and_then(JsValue::str), "design of {name}");
        let norm = |v: &[validate::Issue]| -> Vec<(String, String)> {
            v.iter()
                .map(|i| (i.path.clone(), if i.message.starts_with("not valid JSON:") { "not valid JSON".to_string() } else { i.message.clone() }))
                .collect()
        };
        assert_eq!(norm(&l.errors), issues(case.at("errors")), "errors of {name}");
        assert_eq!(norm(&l.warnings), issues(case.at("warnings")), "warnings of {name}");
    }
}

#[test]
fn ensure_returns_the_design_and_issues() {
    let r = validate::ensure(r##"{"recipe":{"material":"gold","grain":140},"cardholderName":"Ada","shaders":[{"id":"halftone","params":{"cellSize":9}}]}"##)
        .unwrap();
    assert!(r.design.starts_with(r#"{"recipe":{"material":"silver","#), "{}", r.design);
    assert_eq!(r.errors[0].path, "recipe.material");
    assert_eq!(r.warnings[0].path, "recipe.grain");
    assert!(card3d_engine::CardDesign::from_json(&r.design).is_ok());
    assert_eq!(validate::ensure("[1]").unwrap_err().message, "expected a JSON object (a CardDesign)");
    assert_eq!(validate::ensure(r#"{"a":1}"#).unwrap_err().message, "No recipe or card design found in that JSON");
    assert!(validate::ensure("{").unwrap_err().message.starts_with("not valid JSON"));
}

#[test]
fn js_numbers_and_strings() {
    use js::number_to_string as s;
    for (x, want) in [
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (0.1 + 0.2, "0.30000000000000004"),
        (1e21, "1e+21"),
        (1.5e21, "1.5e+21"),
        (1e20, "100000000000000000000"),
        (1e-7, "1e-7"),
        (1.234e-7, "1.234e-7"),
        (0.000001, "0.000001"),
        (-2.5, "-2.5"),
        (5e-324, "5e-324"),
        (f64::MAX, "1.7976931348623157e+308"),
        (123456789.123, "123456789.123"),
    ] {
        assert_eq!(s(x), want);
    }
    assert_eq!(js::round(-2.5), -2.0);
    assert_eq!(js::round(2.5), 3.0);
    assert_eq!(js::round(0.49999999999999994), 0.0);
    assert_eq!(js::string_to_number(" 0x1F "), 31.0);
    assert_eq!(js::string_to_number(""), 0.0);
    assert!(js::string_to_number("1_000").is_nan());
    assert!(js::string_to_number("-0x1").is_nan());
    assert_eq!(js::string_to_number("5."), 5.0);
    assert_eq!(js::slice16("a😀b", 0, 2), "a\u{fffd}");
    // Array-index keys come first, a repeated key keeps its first place.
    let v = js::parse(r#"{"b":1,"2":2,"a":3,"1":4,"b":5}"#).unwrap();
    assert_eq!(js::stringify(&v), r#"{"1":4,"2":2,"b":5,"a":3}"#);
}
