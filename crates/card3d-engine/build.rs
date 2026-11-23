//! Minifies the WGSL under shaders/ into OUT_DIR, where `wgsl!` includes it from. Shader text is
//! data, and data stays in the web build's main module (the wasm-split chunks hold only code), so
//! comments and indentation would be downloaded by every page.
//!
//! The minifier drops comments, indentation, blank lines, repeated spaces and the spaces next to
//! punctuation; a space stays between two words and between two operator characters, so no two
//! tokens merge (`a - -b`, `x * -1.0`). WGSL has no string literals, so `//` and `/*` always
//! start comments. The face shaders (shaders/face/) keep their line structure, which keeps the
//! prelude's line count (custom shader error lines) computed from the text itself; the others are
//! one line.

use std::fs;
use std::path::Path;

fn main() {
    let src = Path::new("shaders");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("shaders");
    println!("cargo:rerun-if-changed=shaders");
    walk(src, &out);
}

fn walk(dir: &Path, out: &Path) {
    fs::create_dir_all(out).unwrap();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let target = out.join(path.file_name().unwrap());
        if path.is_dir() {
            walk(&path, &target);
        } else if path.extension().is_some_and(|e| e == "wgsl") {
            let lines = path.parent().is_some_and(|p| p.ends_with("face"));
            fs::write(target, minify(&fs::read_to_string(&path).unwrap(), lines)).unwrap();
        }
    }
}

fn minify(src: &str, keep_lines: bool) -> String {
    // Comments first: line comments, and block comments (which may span lines and nest).
    let mut text = Vec::with_capacity(src.len());
    let b = src.as_bytes();
    let (mut i, mut depth) = (0, 0);
    while i < b.len() {
        if depth == 0 && b[i..].starts_with(b"//") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if b[i..].starts_with(b"/*") {
            depth += 1;
            i += 2;
        } else if depth > 0 && b[i..].starts_with(b"*/") {
            depth -= 1;
            i += 2;
        } else {
            if depth == 0 || b[i] == b'\n' {
                text.push(b[i]);
            }
            i += 1;
        }
    }
    // Only ASCII bytes are dropped around kept text, so it stays UTF-8.
    let text = String::from_utf8(text).unwrap();
    let word = |c: char| c.is_alphanumeric() || c == '_' || c == '.';
    // Two words, or two operator characters (which could read as one token), keep a space between.
    let op = |c: char| "-+&|=<>!/*%^~".contains(c);
    let apart = |a: char, b: char| (word(a) && word(b)) || (op(a) && op(b));
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }
        if !keep_lines && out.chars().next_back().is_some_and(|a| apart(a, words[0].chars().next().unwrap())) {
            out.push(' ');
        }
        for (k, w) in words.iter().enumerate() {
            if k > 0 {
                let (prev, next) = (words[k - 1].chars().next_back().unwrap(), w.chars().next().unwrap());
                if apart(prev, next) {
                    out.push(' ');
                }
            }
            out.push_str(w);
        }
        if keep_lines {
            out.push('\n');
        }
    }
    if !keep_lines {
        out.push('\n');
    }
    out
}
