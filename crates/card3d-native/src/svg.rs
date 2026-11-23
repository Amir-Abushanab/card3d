//! SVG path data (`new Path2D(d)`) onto a canvas path: M L H V C S Q T A Z, absolute and relative.

use card3d_engine::canvas::Canvas;

fn tokens(d: &str) -> Vec<Tok> {
    let b = d.as_bytes();
    let (mut i, mut out) = (0, Vec::new());
    while i < b.len() {
        let c = b[i] as char;
        if c.is_ascii_alphabetic() && c != 'e' && c != 'E' {
            out.push(Tok::Cmd(c));
            i += 1;
        } else if c.is_ascii_digit() || c == '-' || c == '+' || c == '.' {
            // One number: sign, digits, at most one dot, an optional exponent. "1.5.5" is 1.5 then .5.
            let start = i;
            let mut seen_dot = c == '.';
            let mut seen_e = false;
            i += 1;
            while i < b.len() {
                let ch = b[i] as char;
                if ch.is_ascii_digit() {
                    i += 1;
                } else if ch == '.' && !seen_dot && !seen_e {
                    seen_dot = true;
                    i += 1;
                } else if (ch == 'e' || ch == 'E') && !seen_e {
                    seen_e = true;
                    i += 1;
                    if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
                        i += 1;
                    }
                } else {
                    break;
                }
            }
            if let Ok(v) = d[start..i].parse::<f64>() {
                out.push(Tok::Num(v));
            }
        } else {
            i += 1;
        }
    }
    out
}

#[derive(Clone, Copy)]
enum Tok {
    Cmd(char),
    Num(f64),
}

pub(crate) fn append(c: &mut dyn Canvas, d: &str) {
    let toks = tokens(d);
    let (mut i, mut cmd) = (0usize, 'M');
    let (mut x, mut y, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut last_ctrl: Option<(char, f64, f64)> = None;
    let num = |i: &mut usize| -> Option<f64> {
        match toks.get(*i) {
            Some(Tok::Num(v)) => {
                *i += 1;
                Some(*v)
            }
            _ => None,
        }
    };
    while i < toks.len() {
        if let Tok::Cmd(ch) = toks[i] {
            cmd = ch;
            i += 1;
            if ch == 'Z' || ch == 'z' {
                c.close_path();
                x = sx;
                y = sy;
                last_ctrl = None;
                continue;
            }
        }
        let rel = cmd.is_ascii_lowercase();
        let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
        match cmd.to_ascii_uppercase() {
            'M' => {
                let (Some(a), Some(b)) = (num(&mut i), num(&mut i)) else { break };
                x = ox + a;
                y = oy + b;
                sx = x;
                sy = y;
                c.move_to(x, y);
                cmd = if rel { 'l' } else { 'L' }; // further pairs are lines
                last_ctrl = None;
            }
            'L' => {
                let (Some(a), Some(b)) = (num(&mut i), num(&mut i)) else { break };
                x = ox + a;
                y = oy + b;
                c.line_to(x, y);
                last_ctrl = None;
            }
            'H' => {
                let Some(a) = num(&mut i) else { break };
                x = if rel { x + a } else { a };
                c.line_to(x, y);
                last_ctrl = None;
            }
            'V' => {
                let Some(a) = num(&mut i) else { break };
                y = if rel { y + a } else { a };
                c.line_to(x, y);
                last_ctrl = None;
            }
            'C' | 'S' => {
                let smooth = cmd.eq_ignore_ascii_case(&'S');
                let (c1x, c1y) = if smooth {
                    match last_ctrl {
                        Some(('C', px, py)) => (2.0 * x - px, 2.0 * y - py),
                        _ => (x, y),
                    }
                } else {
                    let (Some(a), Some(b)) = (num(&mut i), num(&mut i)) else { break };
                    (ox + a, oy + b)
                };
                let (Some(a), Some(b), Some(e), Some(f)) = (num(&mut i), num(&mut i), num(&mut i), num(&mut i)) else { break };
                let (c2x, c2y) = (ox + a, oy + b);
                x = ox + e;
                y = oy + f;
                c.bezier_curve_to(c1x, c1y, c2x, c2y, x, y);
                last_ctrl = Some(('C', c2x, c2y));
            }
            'Q' | 'T' => {
                let smooth = cmd.eq_ignore_ascii_case(&'T');
                let (qx, qy) = if smooth {
                    match last_ctrl {
                        Some(('Q', px, py)) => (2.0 * x - px, 2.0 * y - py),
                        _ => (x, y),
                    }
                } else {
                    let (Some(a), Some(b)) = (num(&mut i), num(&mut i)) else { break };
                    (ox + a, oy + b)
                };
                let (Some(e), Some(f)) = (num(&mut i), num(&mut i)) else { break };
                x = ox + e;
                y = oy + f;
                c.quadratic_curve_to(qx, qy, x, y);
                last_ctrl = Some(('Q', qx, qy));
            }
            'A' => {
                let (Some(rx), Some(ry), Some(rot), Some(large), Some(sweep), Some(e), Some(f)) =
                    (num(&mut i), num(&mut i), num(&mut i), num(&mut i), num(&mut i), num(&mut i), num(&mut i))
                else {
                    break;
                };
                let (x2, y2) = (ox + e, oy + f);
                arc(c, x, y, rx, ry, rot.to_radians(), large != 0.0, sweep != 0.0, x2, y2);
                x = x2;
                y = y2;
                last_ctrl = None;
            }
            _ => {
                i += 1; // unknown command: skip its numbers
            }
        }
    }
}

/// An SVG elliptical arc (endpoint form) as cubic Béziers (SVG 1.1 F.6.5 / F.6.6).
fn arc(c: &mut dyn Canvas, x1: f64, y1: f64, rx: f64, ry: f64, phi: f64, large: bool, sweep: bool, x2: f64, y2: f64) {
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx == 0.0 || ry == 0.0 || (x1 == x2 && y1 == y2) {
        c.line_to(x2, y2);
        return;
    }
    let (cp, sp) = (phi.cos(), phi.sin());
    let (dx, dy) = ((x1 - x2) / 2.0, (y1 - y2) / 2.0);
    let (x1p, y1p) = (cp * dx + sp * dy, -sp * dx + cp * dy);
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lambda > 1.0 {
        rx *= lambda.sqrt();
        ry *= lambda.sqrt();
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut k = (num / den).max(0.0).sqrt();
    if large == sweep {
        k = -k;
    }
    let (cxp, cyp) = (k * rx * y1p / ry, -k * ry * x1p / rx);
    let (cx, cy) = (cp * cxp - sp * cyp + (x1 + x2) / 2.0, sp * cxp + cp * cyp + (y1 + y2) / 2.0);
    let ang = |ux: f64, uy: f64, vx: f64, vy: f64| (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    let t1 = ang(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if !sweep && dt > 0.0 {
        dt -= std::f64::consts::TAU;
    } else if sweep && dt < 0.0 {
        dt += std::f64::consts::TAU;
    }
    let n = (dt.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    let step = dt / n as f64;
    let kk = 4.0 / 3.0 * (step / 4.0).tan();
    let point = |t: f64| (cx + rx * t.cos() * cp - ry * t.sin() * sp, cy + rx * t.cos() * sp + ry * t.sin() * cp);
    let deriv = |t: f64| (-rx * t.sin() * cp - ry * t.cos() * sp, -rx * t.sin() * sp + ry * t.cos() * cp);
    let mut t = t1;
    for _ in 0..n {
        let t2 = t + step;
        let (p0, p3) = (point(t), point(t2));
        let (d0, d3) = (deriv(t), deriv(t2));
        c.bezier_curve_to(p0.0 + kk * d0.0, p0.1 + kk * d0.1, p3.0 - kk * d3.0, p3.1 - kk * d3.1, p3.0, p3.1);
        t = t2;
    }
}

/// A liquid-metal mask from SVG text (`toProcessedLiquidMetal`: drawn at 4096 px on its longer side):
/// the `<path>` elements (their `d` and `fill-rule`) filled in the `viewBox` (else `width` × `height`).
/// Enough for path-only masks; other elements are left out.
pub(crate) fn rasterize_mask(bytes: &[u8]) -> Option<card3d_engine::canvas::Image> {
    use card3d_engine::canvas::{FillRule, Paint};
    let raw = String::from_utf8_lossy(bytes);
    // Percent-encoded data URL text.
    let mut text = Vec::with_capacity(raw.len());
    let b = raw.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match (b[i], b.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok())) {
            (b'%', Some(v)) => {
                text.push(v);
                i += 3;
            }
            (c, _) => {
                text.push(c);
                i += 1;
            }
        }
    }
    let text = String::from_utf8_lossy(&text);
    let attr = |tag: &str, name: &str| -> Option<String> {
        let at = tag.find(&format!(" {name}=")).or_else(|| tag.find(&format!("\n{name}=")))? + name.len() + 2;
        let q = tag[at..].chars().next()?;
        let rest = &tag[at + 1..];
        Some(rest[..rest.find(q)?].to_string())
    };
    let svg_start = text.find("<svg")?;
    let svg_tag = &text[svg_start..svg_start + text[svg_start..].find('>')?];
    let num = |v: Option<String>| v.and_then(|v| v.trim_end_matches("px").trim().parse::<f64>().ok());
    let (vx, vy, vw, vh) = match attr(svg_tag, "viewBox").map(|v| v.split([' ', ',']).filter_map(|n| n.parse::<f64>().ok()).collect::<Vec<_>>()) {
        Some(v) if v.len() == 4 => (v[0], v[1], v[2], v[3]),
        _ => (0.0, 0.0, num(attr(svg_tag, "width"))?, num(attr(svg_tag, "height"))?),
    };
    let (w, h) = (num(attr(svg_tag, "width")).unwrap_or(vw), num(attr(svg_tag, "height")).unwrap_or(vh));
    if !(w > 0.0 && h > 0.0 && vw > 0.0 && vh > 0.0) {
        return None;
    }
    let (ow, oh) = if w > h { (4096.0, 4096.0 / (w / h)) } else { (4096.0 * (w / h), 4096.0) };
    let mut c = crate::SkiaCanvas::new(ow as u32, oh as u32);
    c.scale(ow / vw, oh / vh);
    c.translate(-vx, -vy);
    c.set_fill(Paint::color("#000"));
    let mut rest: &str = &text;
    while let Some(at) = rest.find("<path") {
        let tag = &rest[at..at + rest[at..].find('>').unwrap_or(rest.len() - at)];
        if let Some(d) = attr(tag, "d") {
            c.begin_path();
            append(&mut c, &d);
            c.fill(if attr(tag, "fill-rule").as_deref() == Some("evenodd") { FillRule::EvenOdd } else { FillRule::NonZero });
        }
        rest = &rest[at + 5..];
    }
    let rgba = c.get_image_data();
    Some(card3d_engine::canvas::Image { width: c.width(), height: c.height(), rgba })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_numbers_like_browsers() {
        let t: Vec<f64> = tokens("M1.5.5-2e1L.25,3").into_iter().filter_map(|t| if let Tok::Num(v) = t { Some(v) } else { None }).collect();
        assert_eq!(t, vec![1.5, 0.5, -20.0, 0.25, 3.0]);
    }
}
