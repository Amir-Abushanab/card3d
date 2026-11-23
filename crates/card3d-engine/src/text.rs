//! The card's text rasters (`card/name-texture.ts`): the cardholder name and bio (upper-cased, bold
//! 100 px, word-wrapped to the layout's line budget) and the extra text lines (one line, letter
//! spacing), white on transparent with 6 px padding, drawn on a host canvas.
//!
//! Graphemes are approximated by Unicode scalar values (the TypeScript engine uses `Intl.Segmenter`
//! where it exists): identical for Latin text, it only matters for an over-long word or the ellipsis
//! in scripts with combining sequences.

use crate::canvas::{Canvas, Host, Paint};

/// Gap between lines and the total horizontal / vertical padding (6 px each side), px.
pub const TEXT_LINE_GAP: f64 = 18.0;
pub const TEXT_PADDING: f64 = 12.0;

/// A text raster: RGBA pixels (rows top first, white, alpha = coverage), size, and the layout facts
/// the branding needs.
pub struct TextRaster {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// width / height.
    pub aspect: f64,
    /// The raster's height in line boxes (ascent + descent of "Hg").
    pub height_in_line_boxes: f64,
}

/// Ascent of "Hg" (rounded up) and the line height (ascent + descent), px.
#[derive(Clone, Copy, Debug)]
pub struct LineMetrics {
    pub asc: f64,
    pub line_h: f64,
}

/// `layoutCardText` on text already upper-cased (`Host::uppercase`): the lines and canvas size, or
/// `None` for empty text. `measure` gives a string's advance width in px; `max_width_lines` /
/// `max_height_lines` are in line boxes (∞ = unlimited).
pub fn layout_card_text(
    text: &str,
    measure: &mut dyn FnMut(&str) -> f64,
    metrics: LineMetrics,
    max_width_lines: f64,
    max_height_lines: f64,
) -> Option<(Vec<String>, u32, u32)> {
    let s = text.trim();
    if s.is_empty() {
        return None;
    }
    let line_h = metrics.line_h;
    let g = TEXT_LINE_GAP;
    let max_w = if max_width_lines.is_finite() { (max_width_lines * line_h - TEXT_PADDING).max(1.0) } else { f64::INFINITY };

    let mut lines: Vec<String> = Vec::new();
    if max_w.is_finite() {
        for para in s.split('\n') {
            let words: Vec<&str> = para.split_whitespace().collect();
            if words.is_empty() {
                lines.push(String::new());
                continue;
            }
            let mut tokens: Vec<String> = Vec::new();
            for w in words {
                if measure(w) > max_w {
                    tokens.extend(break_word(w, measure, max_w));
                } else {
                    tokens.push(w.to_string());
                }
            }
            let mut line = String::new();
            for t in tokens {
                let candidate = if line.is_empty() { t.clone() } else { format!("{line} {t}") };
                if line.is_empty() || measure(&candidate) <= max_w {
                    line = candidate;
                } else {
                    lines.push(std::mem::replace(&mut line, t));
                }
            }
            lines.push(line);
        }
    } else {
        lines = s.split('\n').map(str::to_string).collect();
    }

    if max_height_lines.is_finite() {
        let max_lines = ((max_height_lines * line_h - TEXT_PADDING + g) / (line_h + g)).floor().max(1.0) as usize;
        if lines.len() > max_lines {
            lines.truncate(max_lines);
            let mut last = lines[max_lines - 1].clone();
            while !last.is_empty() && measure(&format!("{last}…")) > max_w {
                last.pop();
                last = last.trim_end().to_string();
            }
            lines[max_lines - 1] = format!("{last}…");
        }
    }

    let n = lines.len() as f64;
    let widest = lines.iter().map(|l| measure(l)).fold(0.0, f64::max);
    let width = (widest + TEXT_PADDING).ceil() as u32;
    let height = (n * line_h + (n - 1.0) * g + TEXT_PADDING).ceil() as u32;
    Some((lines, width, height))
}

/// Breaks an over-long word into greedy chunks, never leaving an empty piece.
fn break_word(word: &str, measure: &mut dyn FnMut(&str) -> f64, max_w: f64) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut cur = String::new();
    for c in word.chars() {
        let candidate = format!("{cur}{c}");
        if !cur.is_empty() && measure(&candidate) > max_w {
            pieces.push(std::mem::replace(&mut cur, c.to_string()));
        } else {
            cur = candidate;
        }
    }
    if !cur.is_empty() {
        pieces.push(cur);
    }
    pieces
}

/// `cardTextFont`: a single family is quoted; a list is used as given.
pub fn card_text_font(family: &str) -> String {
    if family.contains([',', '"', '\'']) {
        format!("700 100px {family}, Arial, sans-serif")
    } else {
        format!("700 100px \"{family}\", Arial, sans-serif")
    }
}

fn line_metrics(c: &mut dyn Canvas) -> LineMetrics {
    let hg = c.measure_text("Hg");
    let or = |v: f64, d: f64| if v != 0.0 { v } else { d };
    let asc = or(hg.ascent, 72.0).ceil();
    LineMetrics { asc, line_h: asc + or(hg.descent, 20.0).ceil() }
}

/// `rasterizeCardText`: the name or bio, wrapped to the layout's budget. `None` for empty text.
pub fn rasterize_card_text(host: &dyn Host, text: &str, family: &str, max_width_lines: f64, max_height_lines: f64) -> Option<TextRaster> {
    if text.trim().is_empty() {
        return None;
    }
    let mut c = host.canvas(2048, 256);
    let font = card_text_font(family);
    c.set_font(&font);
    let m = line_metrics(c.as_mut());
    let (lines, width, height) = {
        let canvas = &mut c;
        layout_card_text(&host.uppercase(text), &mut |s| canvas.measure_text(s).width, m, max_width_lines, max_height_lines)?
    };
    c.resize(width, height);
    c.set_font(&font);
    c.set_fill(Paint::color("#ffffff"));
    for (k, line) in lines.iter().enumerate() {
        c.fill_text(line, 6.0, 6.0 + m.asc + k as f64 * (m.line_h + TEXT_LINE_GAP));
    }
    Some(TextRaster { width, height, rgba: c.get_image_data(), aspect: width as f64 / height as f64, height_in_line_boxes: height as f64 / m.line_h })
}

/// `rasterizeTextLine`: one extra text line (never wrapped; newlines become spaces), letter spacing
/// `tracking` em through the canvas's `letterSpacing` (the TypeScript engine's path in browsers that
/// have it, all current ones), without the trailing space it adds after the last character.
pub fn rasterize_text_line(host: &dyn Host, text: &str, family: &str, tracking: f64) -> Option<TextRaster> {
    let s = host.uppercase(&text.split_whitespace().collect::<Vec<_>>().join(" "));
    if s.is_empty() {
        return None;
    }
    let mut c = host.canvas(2048, 256);
    let font = card_text_font(family);
    let spacing = (tracking * 100.0 * 10.0).round() / 10.0;
    c.set_font(&font);
    c.set_letter_spacing(spacing);
    let m = line_metrics(c.as_mut());
    let width = c.measure_text(&s).width - spacing;
    let w = (width + TEXT_PADDING).ceil().clamp(1.0, 8192.0) as u32;
    let h = (m.line_h + TEXT_PADDING).ceil() as u32;
    c.resize(w, h);
    c.set_font(&font); // resizing resets the context
    c.set_letter_spacing(spacing);
    c.set_fill(Paint::color("#ffffff"));
    c.fill_text(&s, 6.0, 6.0 + m.asc);
    Some(TextRaster { width: w, height: h, rgba: c.get_image_data(), aspect: w as f64 / h as f64, height_in_line_boxes: h as f64 / m.line_h })
}
