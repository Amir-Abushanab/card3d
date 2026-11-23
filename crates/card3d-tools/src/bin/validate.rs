//! `validate`: the Rust design validator (`card3d_engine::validate`) over stdin, for
//! validate-compare.ts. Each input line is a JSON string holding a design's JSON text; each output
//! line is `{ "design": <the design JSON text or null>, "errors": [...], "warnings": [...] }` with
//! `{ path, message }` issues, as `lintDesign` returns them.
//!
//! `validate <file.json>...` validates files instead and prints each one's report.

use card3d_engine::validate::{self, js, JsValue};
use std::io::{BufRead, Write};

fn report(text: &str) -> String {
    let l = validate::lint(text);
    let issues = |v: &[validate::Issue]| {
        JsValue::Arr(
            v.iter()
                .map(|i| {
                    let mut o = js::Obj::new();
                    o.set("path", JsValue::Str(i.path.clone()));
                    o.set("message", JsValue::Str(i.message.clone()));
                    JsValue::Obj(o)
                })
                .collect(),
        )
    };
    let mut o = js::Obj::new();
    o.set("design", l.design.as_ref().map_or(JsValue::Null, |d| JsValue::Str(js::stringify(d))));
    o.set("errors", issues(&l.errors));
    o.set("warnings", issues(&l.warnings));
    js::stringify(&JsValue::Obj(o))
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    if !files.is_empty() {
        for f in files {
            let text = std::fs::read_to_string(&f).unwrap_or_else(|e| panic!("{f}: {e}"));
            writeln!(out, "{f}\t{}", report(&text)).unwrap();
        }
        return;
    }
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let text = match js::parse(&line) {
            Ok(JsValue::Str(t)) => t,
            _ => panic!("each line must be a JSON string"),
        };
        writeln!(out, "{}", report(&text)).unwrap();
    }
}
