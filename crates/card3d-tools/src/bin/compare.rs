//! `compare <out-dir> <a> <b>`: for every `<out-dir>/<design>/` holding `<a>-<pose>.png` and
//! `<b>-<pose>.png` (e.g. `three` and `rust`; the four parity poses first, then any other pose name,
//! such as the marquee's strip states), both composited over mid grey: the mean absolute error
//! per channel (0–255) and the share of card pixels off by more than 8 / 24. Prints a table, writes
//! `<out-dir>/compare-<b>.json` and, for poses over the bar, `<design>/diff-<b>-<pose>.png`
//! (a | b | difference × 4). The target is a mean error under 0.5 (marked `!` when missed); a pose
//! fails, and the run exits 1, at a mean error of 0.75 or more, or more than 1 % of card pixels off by
//! more than 24 (a real local difference rather than noise). Designs listed for this build in
//! `crates/card3d-tools/known-differences.json` (with the reason) are reported as KNOWN, not FAIL. An
//! entry may be `{ "reason", "maxMae", "maxOver24" }`: it is KNOWN only within those limits, and fails
//! past them (so a real regression in that design still shows). The entries are differences from
//! three.js (`<a>` = `three`); comparing two engine builds (`<a>` = `rust`), both builds' entries apply.
#![allow(clippy::print_stdout, clippy::print_stderr, reason = "a command-line tool: printing is its output")]

use std::path::Path;

const POSES: [&str; 4] = ["front", "tilt", "back", "edge"];
const TARGET_MAE: f64 = 0.5;
const FAIL_MAE: f64 = 0.75;
const FAIL_OVER24: f64 = 1.0;

fn load(path: &Path) -> Option<(u32, u32, Vec<u8>)> {
    let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).ok()?));
    let mut r = dec.read_info().ok()?;
    let mut buf = vec![0; r.output_buffer_size()?];
    let info = r.next_frame(&mut buf).ok()?;
    assert_eq!(info.color_type, png::ColorType::Rgba, "{}", path.display());
    Some((info.width, info.height, buf))
}

fn over_grey(p: &[u8]) -> [f32; 3] {
    let a = p[3] as f32 / 255.0;
    [0, 1, 2].map(|c| p[c] as f32 * a + 128.0 * (1.0 - a))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [out, a_name, b_name] = &args[..] else {
        eprintln!("usage: compare <out-dir> <a> <b>");
        std::process::exit(2);
    };
    let out = Path::new(out);
    let known: serde_json::Value = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("known-differences.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    // A listed design is KNOWN when within its entry's limits (none for a plain reason string). The
    // entries are each build's differences from three.js; when two builds are compared with each other
    // (compare.mjs without the three.js archive: the web builds against the native render), either
    // side's entry explains the pair, within the sum of both sides' limits (a side without an entry adds
    // the fail bar).
    let sides = if a_name == "three" { 1 } else { 2 };
    let is_known = |design: &str, mae: f64, p24: f64| {
        let entries: Vec<&serde_json::Value> = [a_name, b_name].iter().filter_map(|n| known.get(n.as_str()).and_then(|b| b.get(design))).collect();
        if entries.is_empty() {
            return false;
        }
        let within = |key: &str, bar: f64, v: f64| {
            let mut total = bar * (sides - entries.len().min(sides)) as f64;
            for e in &entries {
                match e.get(key).and_then(serde_json::Value::as_f64) {
                    Some(max) => total += max,
                    None => return true,
                }
            }
            v <= total
        };
        within("maxMae", FAIL_MAE, mae) && within("maxOver24", FAIL_OVER24, p24)
    };
    let mut known_count = 0;
    let mut dirs: Vec<_> = std::fs::read_dir(out).unwrap().flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect();
    dirs.sort();
    let (mut failed, mut compared, mut worst) = (0, 0, 0.0f64);
    let mut summary = Vec::new();
    for dir in dirs {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let mut cells = Vec::new();
        // The parity poses, then any other `<a>-<pose>.png` (the marquee's strip states), by name.
        let prefix = format!("{a_name}-");
        let mut extra: Vec<String> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_prefix(&prefix)?.strip_suffix(".png").map(str::to_string))
            .filter(|p| !POSES.contains(&p.as_str()))
            .collect();
        extra.sort();
        let poses: Vec<&str> = POSES.iter().copied().chain(extra.iter().map(String::as_str)).collect();
        for pose in poses {
            let (Some((w, h, a)), Some((w2, h2, b))) = (load(&dir.join(format!("{a_name}-{pose}.png"))), load(&dir.join(format!("{b_name}-{pose}.png"))))
            else {
                continue;
            };
            assert_eq!((w, h), (w2, h2), "{name} {pose}: sizes differ");
            let (mut sum, mut n8, mut n24, mut card) = (0.0f64, 0usize, 0usize, 0usize);
            let mut side = vec![0u8; (9 * w * h) as usize];
            for i in 0..(w * h) as usize {
                let (pa, pb) = (over_grey(&a[4 * i..]), over_grey(&b[4 * i..]));
                let d = (0..3).map(|c| (pa[c] - pb[c]).abs()).fold(0.0f32, f32::max);
                if a[4 * i + 3] > 0 || b[4 * i + 3] > 0 {
                    card += 1;
                    sum += (0..3).map(|c| (pa[c] - pb[c]).abs() as f64).sum::<f64>() / 3.0;
                    n8 += (d > 8.0) as usize;
                    n24 += (d > 24.0) as usize;
                }
                let (x, y) = (i as u32 % w, i as u32 / w);
                for (k, px) in [pa, pb, [(d * 4.0).min(255.0); 3]].iter().enumerate() {
                    let o = (3 * (y * 3 * w + k as u32 * w + x)) as usize;
                    side[o..o + 3].copy_from_slice(&px.map(|v| v.round() as u8));
                }
            }
            let card = card.max(1) as f64;
            let mae = sum / card;
            let (p8, p24) = (100.0 * n8 as f64 / card, 100.0 * n24 as f64 / card);
            let over = mae >= TARGET_MAE;
            let over_bar = mae >= FAIL_MAE || p24 > FAIL_OVER24;
            let known_diff = over_bar && is_known(&name, mae, p24);
            let fail = over_bar && !known_diff;
            if fail {
                failed += 1;
            }
            if known_diff {
                known_count += 1;
            }
            if over || fail {
                let file = std::fs::File::create(dir.join(format!("diff-{b_name}-{pose}.png"))).unwrap();
                let mut enc = png::Encoder::new(std::io::BufWriter::new(file), 3 * w, h);
                enc.set_color(png::ColorType::Rgb);
                enc.write_header().unwrap().write_image_data(&side).unwrap();
            }
            compared += 1;
            worst = worst.max(mae);
            cells.push(format!(
                "{pose} {mae:.2}{}",
                if fail {
                    " FAIL"
                } else if known_diff {
                    " KNOWN"
                } else if over {
                    "!"
                } else {
                    ""
                }
            ));
            summary.push(format!("{{\"design\":\"{name}\",\"pose\":\"{pose}\",\"mae\":{mae:.4},\"over8\":{p8:.3},\"over24\":{p24:.3}}}"));
        }
        if !cells.is_empty() {
            println!("{name:<40} {}", cells.join("  "));
        }
    }
    std::fs::write(out.join(format!("compare-{b_name}.json")), format!("[{}]\n", summary.join(",\n"))).unwrap();
    let missed = summary
        .iter()
        .filter(|j| {
            j.contains("\"mae\":")
                && j.split("\"mae\":").nth(1).and_then(|v| v.split(',').next()).and_then(|v| v.parse::<f64>().ok()).is_some_and(|v| v >= TARGET_MAE)
        })
        .count();
    println!("\n{compared} renders compared ({b_name} vs {a_name}), worst mean error {worst:.2}; {missed} above the {TARGET_MAE} target, {failed} failed, {known_count} known");
    if failed > 0 {
        std::process::exit(1);
    }
}
