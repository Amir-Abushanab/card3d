//! The vine model (`addons/vines/model.ts`): main vines, branches, leaves and the
//! strands that wrap the card's edge, from the ivy card's LCG (seed 10729). Pure and deterministic:
//! every random draw happens in the TypeScript's order, including the conditional ones.
//!
//! Leaf counts are `round(10·length)` on branch lengths that sit on exact multiples of 0.025, so the
//! last bit of each step can decide whole leaves. `hypot` is therefore V8's (Kahan-summed), and `sin`,
//! `cos` and `atan2` come from the `libm` crate (fdlibm) so that native and web builds agree; against
//! V8 (whose `sin` / `cos` are glibc's) every count and choice is the same and the coordinates differ
//! by 2e-16 at most (tests/vines.rs). Only the add-on chunks use this module.

use std::f64::consts::PI;

/// The vines' LCG: state·1664525 + 1013904223 mod 2³², / 2³².
pub struct Lcg(u32);

impl Lcg {
    pub fn new(seed: u32) -> Lcg {
        Lcg(seed)
    }
    #[allow(clippy::should_implement_trait, reason = "a random generator, not an Iterator: it never ends")]
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0 as f64 / 4294967296.0
    }
}

pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}

/// V8's `Math.hypot` of two values: normalised by the larger, squares Kahan-summed.
pub fn hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    let max = a.max(b);
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0f64, 0.0f64);
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.round`: halves round up.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `Math.sign`, with 0 for ±0.
fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

pub type Pt = [f64; 2];
pub type V3 = [f64; 3];

pub struct Stem {
    pub pts: Vec<Pt>,
    pub prog: Vec<f64>,
    pub width: f64,
    pub end: f64,
    pub phase: f64,
    pub side: f64,
    /// Identities of the first and last point (the TypeScript compares point objects: a main
    /// vine's next polyline starts with the very point that ends the previous one).
    head: usize,
    tail: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Leaf {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub angle: f64,
    pub face: V3,
    pub lift: f64,
    pub kz: f64,
    pub phase: f64,
    pub progress: f64,
    pub variant: f64,
    pub seed: f64,
    pub side: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrandNode {
    pub p: V3,
    pub n: V3,
    pub width: f64,
    pub progress: f64,
    pub phase: f64,
}

pub struct IvyModel {
    pub stems: Vec<Stem>,
    /// Sorted by lift ascending (the draw order).
    pub leaves: Vec<Leaf>,
    /// One ribbon per chain (root stem → linked stems, wrapped around the edge).
    pub strands: Vec<Vec<StrandNode>>,
    /// Leaves grown along stems (before the crossing leaves).
    pub stem_leaf_count: usize,
}

const HALF_X: f64 = 1.685;
const HALF_Y: f64 = 1.0625;
const CORNER_R: f64 = 0.14;
const INNER_X: f64 = 1.545;
const INNER_Y: f64 = 0.9225;

pub struct Sdf {
    pub d: f64,
    pub nx: f64,
    pub ny: f64,
}

/// Rounded-rect distance (half size 1.685 × 1.0625, radius 0.14) with the outward unit normal.
pub fn sdf(x: f64, y: f64) -> Sdf {
    let ax = x.abs() - INNER_X;
    let ay = y.abs() - INNER_Y;
    if ax > 0.0 && ay > 0.0 {
        let l = hypot(ax, ay);
        return Sdf { d: l - CORNER_R, nx: sign(x) * ax / l, ny: sign(y) * ay / l };
    }
    let dx = x.abs() - HALF_X;
    let dy = y.abs() - HALF_Y;
    let or1 = |s: f64| if s == 0.0 { 1.0 } else { s };
    if dx > dy {
        return Sdf { d: dx, nx: or1(sign(x)), ny: 0.0 };
    }
    Sdf { d: dy, nx: 0.0, ny: or1(sign(y)) }
}

fn inside(x: f64, y: f64) -> bool {
    x.abs() < 1.64 && y.abs() < 1.02
}

/// Front-side avoid zones (logo, name, chip): centre x, y, width, height.
const AVOID: [[f64; 4]; 3] = [[-1.3614, 0.7969, 0.2429, 0.2125], [-1.0018, -0.8111, 0.9621, 0.1203], [1.09525, -0.163518, 0.5055, 0.433286]];

fn avoid(x: f64, y: f64, margin: f64) -> bool {
    AVOID.iter().any(|[cx, cy, w, h]| (x - cx).abs() < w / 2.0 + margin && (y - cy).abs() < h / 2.0 + margin)
}

/// Uniform Catmull-Rom with clamped end neighbours; t clamped to [0, 0.999999].
fn cr_sample(pts: &[Pt], t: f64) -> Pt {
    let n = pts.len();
    let u = t.clamp(0.0, 0.999999) * (n - 1) as f64;
    let i = u.floor() as usize;
    let f = u - i as f64;
    let p0 = pts[i.saturating_sub(1)];
    let p1 = pts[i];
    let p2 = pts[(i + 1).min(n - 1)];
    let p3 = pts[(i + 2).min(n - 1)];
    let c =
        |a: f64, b: f64, c: f64, d: f64| 0.5 * (2.0 * b + (c - a) * f + (2.0 * a - 5.0 * b + 4.0 * c - d) * f * f + (3.0 * b - a - 3.0 * c + d) * f * f * f);
    [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]
}

/// Rodrigues rotation taking +Z to the unit vector f.
pub fn turn(v: V3, f: V3) -> V3 {
    let s = hypot(f[0], f[1]);
    if s < 1e-4 {
        return v;
    }
    let kx = -f[1] / s;
    let ky = f[0] / s;
    let c = f[2];
    let kxv = [ky * v[2], -kx * v[2], kx * v[1] - ky * v[0]];
    let kdv = kx * v[0] + ky * v[1];
    [v[0] * c + kxv[0] * s + kx * kdv * (1.0 - c), v[1] * c + kxv[1] * s + ky * kdv * (1.0 - c), v[2] * c + kxv[2] * s]
}

/// Point (u, v) of a leaf quad lying on its face plane.
fn leaf_point(l: &Leaf, u: f64, v: f64) -> V3 {
    let ca = cos(l.angle);
    let sa = sin(l.angle);
    let sx = turn([ca, sa, 0.0], l.face);
    let ty = turn([-sa, ca, 0.0], l.face);
    let a = (u - 0.5) * l.width;
    let b = v * l.height;
    [l.x + a * sx[0] + b * ty[0], l.y + a * sx[1] + b * ty[1], a * sx[2] + b * ty[2]]
}

/// The main vines : polylines per vine, alternating sides.
pub const MAIN_VINES: [&[&[Pt]]; 11] = [
    &[
        &[[1.71, -1.05], [1.46, -0.66], [1.47, -0.3], [1.52, 0.04], [1.45, 0.38], [1.3, 0.7], [1.54, 0.94], [1.67, 1.06]],
        &[[1.38, 0.8], [1.12, 0.52], [1.24, 0.18], [0.96, -0.12], [1.06, -0.48], [0.84, -0.78]],
    ],
    &[
        &[[0.7, -1.08], [0.56, -0.62], [0.62, -0.2], [0.5, 0.3], [0.66, 0.84], [0.47, 1.1]],
        &[[0.4, 0.78], [0.14, 0.55], [0.26, 0.2], [-0.06, -0.04], [0.06, -0.4], [-0.2, -0.72]],
    ],
    &[
        &[[1.72, 0.62], [1.52, 0.7], [1.02, 0.8], [0.48, 0.65], [-0.03, 0.88], [-0.62, 0.69], [-0.8, 1.09]],
        &[[-0.7, 0.8], [-0.94, 0.52], [-0.8, 0.22], [-1.04, -0.02], [-0.98, -0.36]],
    ],
    &[&[[1.72, 0.2], [1.42, 0.26], [0.98, 0.37], [0.52, 0.1], [0.06, 0.22], [-0.46, 0.42]]],
    &[
        &[[1.72, -0.56], [1.54, -0.49], [1.05, -0.71], [0.64, -0.79], [0.18, -0.56], [-0.29, -0.58], [-0.42, -0.84], [-0.5, -0.98], [-0.8, -1.09]],
        &[[-1.04, -0.8], [-0.74, -0.56], [-0.86, -0.22], [-0.54, 0.04], [-0.66, 0.4], [-0.4, 0.7]],
    ],
    &[
        &[[-1.69, -0.41], [-1.33, -0.21], [-1.39, 0.17], [-1.18, 0.5], [-1.14, 0.8], [-1.1, 1.09]],
        &[[-1.26, 0.8], [-1.46, 0.5], [-1.3, 0.14], [-1.5, -0.2], [-1.34, -0.6], [-1.48, -0.9]],
    ],
    &[&[[1.72, 0.44], [1.2, 0.48], [0.94, 0.62], [0.98, 0.96], [1.05, 1.09]], &[[0.9, 0.78], [0.66, 0.62], [0.7, 0.3], [0.46, 0.06]]],
    &[&[[0.66, -0.44], [0.33, -0.27], [0.13, -0.04], [-0.22, 0.02]]],
    &[&[[-1.72, -1.05], [-1.6, -0.9], [-1.56, -0.7], [-1.42, -0.62], [-1.1, -0.56], [-0.78, -0.3], [-0.44, -0.14]]],
    &[&[[-0.3, 1.08], [-0.44, 0.74], [-0.72, 0.42], [-0.98, 0.1], [-1.12, -0.26]]],
    &[&[[1.7, -0.3], [1.42, -0.48], [1.1, -0.5], [0.8, -0.47], [0.52, -0.4]]],
];

/// A main vine's phase in the 80 s cycle (`0.382·a mod 1`).
pub fn vine_phase(a: usize) -> f64 {
    (0.382 * a as f64) % 1.0
}

fn poly_length(pts: &[Pt]) -> f64 {
    let mut l = 0.0;
    for i in 1..pts.len() {
        l += hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    l
}

const STEP: f64 = 0.025;

struct Grower<'a> {
    rand: &'a mut Lcg,
    stems: &'a mut Vec<Stem>,
    /// The next point identity.
    ids: &'a mut usize,
}

fn fresh(ids: &mut usize) -> usize {
    *ids += 1;
    *ids
}

impl Grower<'_> {
    fn grow(&mut self, mut x: f64, mut y: f64, mut heading: f64, max_len: f64, width: f64, p0: f64, total_len: f64, phase: f64, depth: u32, side: f64) {
        let mut pts: Vec<Pt> = vec![[x, y]];
        let mut prog = vec![p0];
        let wob = (self.rand.next() - 0.5) * 3.0;
        let mut e = STEP;
        while e <= max_len && p0 + e / total_len <= 1.0 {
            heading += STEP * wob + 0.035 * sin(24.0 * e + depth as f64) + 0.012 * cos(heading);
            x += STEP * cos(heading);
            y += STEP * sin(heading);
            if !inside(x, y) || (side > 0.0 && avoid(x, y, 0.04)) {
                break;
            }
            pts.push([x, y]);
            prog.push(p0 + e / total_len);
            e += STEP;
        }
        if pts.len() < 5 {
            return;
        }
        let n = pts.len();
        let (head, tail) = (fresh(self.ids), fresh(self.ids));
        self.stems.push(Stem { pts: pts.clone(), prog: prog.clone(), width, end: 0.32 * width, phase, side, head, tail });
        if depth < 2 && n > 9 && self.rand.next() < 0.55 {
            let k = (n as f64 * (0.35 + 0.3 * self.rand.next())).floor() as usize;
            let a = pts[k];
            let b = pts[k - 1];
            let sgn = if self.rand.next() < 0.5 { -1.0 } else { 1.0 };
            let h2 = atan2(a[1] - b[1], a[0] - b[0]) + sgn * (0.6 + 0.4 * self.rand.next());
            self.grow(a[0], a[1], h2, 0.55 * max_len, 0.7 * width, prog[k], total_len, phase, depth + 1, side);
        }
    }
}

/// The model (`generateIvy`; the ivy card's seed is 10729).
#[allow(clippy::approx_constant, clippy::needless_range_loop, reason = "6.28 is the spec's literal, not τ; the index loops follow the TypeScript")]
pub fn generate_ivy(seed: u32) -> IvyModel {
    let mut rand = Lcg::new(seed);
    let mut stems: Vec<Stem> = Vec::new();
    let mut ids = 0;

    for (a, vine) in MAIN_VINES.iter().enumerate() {
        let phase = vine_phase(a);
        let base_w = if a < 2 { 0.016 } else { 0.011 };
        let s = vine[0][0];
        let c = vine[0][1];
        let wraps_in = sdf(s[0], s[1]).d > 0.0;
        let dl = hypot(c[0] - s[0], c[1] - s[1]);
        let dir = [(c[0] - s[0]) / dl, (c[1] - s[1]) / dl];
        let p = |e: f64, ang: f64| -> Pt {
            let (ca, sa) = (cos(ang), sin(ang));
            [s[0] + (dir[0] * ca - dir[1] * sa) * e, s[1] + (dir[0] * sa + dir[1] * ca) * e]
        };
        let pa = p(0.4, 0.5);
        let pb = p(0.4, -0.5);
        let mside = if sdf(pa[0], pa[1]).d < sdf(pb[0], pb[1]).d { 0.5 } else { -0.5 };
        let mut polys: Vec<Vec<Pt>> = Vec::new();
        if wraps_in {
            polys.push(vec![p(0.4, mside), p(0.2, 0.5 * mside), s]);
        }
        polys.extend(vine.iter().map(|v| v.to_vec()));
        let sides: Vec<f64> = (0..polys.len()).map(|j| if (j + wraps_in as usize) % 2 == 1 { -1.0 } else { 1.0 }).collect();

        // Resample each polyline at 49 points with a small sideways wobble.
        let mut samples: Vec<Vec<Pt>> = Vec::new();
        for (j, poly) in polys.iter().enumerate() {
            let ctrl: Vec<Pt> = if j > 0 && !(wraps_in && j == 1) {
                let mut c = vec![samples[j - 1][48]];
                c.extend_from_slice(poly);
                c
            } else {
                poly.clone()
            };
            let mut out: Vec<Pt> = Vec::with_capacity(49);
            for k in 0..=48 {
                let kf = k as f64;
                let p = cr_sample(&ctrl, kf / 48.0);
                let q = cr_sample(&ctrl, kf / 48.0 + 0.004);
                let dx = q[0] - p[0];
                let dy = q[1] - p[1];
                let len = hypot(dx, dy);
                let len = if len == 0.0 { 1.0 } else { len };
                let off = 0.0035 * sin(1.9 * kf + a as f64) + 0.016 * sin(0.63 * kf + 2.0 * a as f64);
                out.push([p[0] + (-dy / len) * off, p[1] + (dx / len) * off]);
            }
            if j > 0 {
                out[0] = samples[j - 1][48];
            }
            samples.push(out);
        }

        // Cumulative arc length over all samples.
        let mut total = 0.0;
        let mut last: Option<Pt> = None;
        let cum: Vec<Vec<f64>> = samples
            .iter()
            .map(|pts| {
                pts.iter()
                    .map(|p| {
                        if let Some(l) = last {
                            total += hypot(p[0] - l[0], p[1] - l[1]);
                        }
                        last = Some(*p);
                        total
                    })
                    .collect()
            })
            .collect();
        let x_total = total;
        let progs: Vec<Vec<f64>> = cum.iter().map(|l| l.iter().map(|v| v / x_total).collect()).collect();

        let mut prev_tail = 0;
        for (j, pts) in samples.iter().enumerate() {
            let prog = &progs[j];
            let side = sides[j];
            let head = if j > 0 { prev_tail } else { fresh(&mut ids) };
            let tail = fresh(&mut ids);
            prev_tail = tail;
            stems.push(Stem {
                pts: pts.clone(),
                prog: prog.clone(),
                width: base_w * (1.0 - 0.68 * prog[0]),
                end: base_w * (1.0 - 0.68 * prog[48]),
                phase,
                side,
                head,
                tail,
            });
            let count = if wraps_in && j == 0 {
                1
            } else if side < 0.0 {
                3
            } else {
                4
            };
            for r in 0..count {
                let rf = r as f64;
                let idx = js_round((0.16 + rf * (if side < 0.0 { 0.25 } else { 0.2 }) + 0.12 * rand.next()) * 48.0) as usize;
                let p = pts[idx];
                let q = pts[idx - 1];
                let heading = atan2(p[1] - q[1], p[0] - q[0]) + (if r % 2 == 1 { 1.0 } else { -1.0 }) * (0.5 + 0.5 * rand.next());
                let max_len = 0.28 + 0.4 * rand.next();
                Grower { rand: &mut rand, stems: &mut stems, ids: &mut ids }.grow(
                    p[0],
                    p[1],
                    heading,
                    max_len,
                    0.62 * base_w * (1.0 - 0.68 * prog[idx]),
                    prog[idx],
                    x_total,
                    phase,
                    1,
                    side,
                );
            }
        }
    }

    // Leaves along the stems.
    let mut leaves: Vec<Leaf> = Vec::new();
    for stem in &stems {
        let n = stem.pts.len();
        let count = js_round(10.0 * poly_length(&stem.pts)) as usize;
        for k in 0..count {
            let c = (k as f64 + 0.3 + 0.35 * rand.next()) / count as f64;
            let fi = c * (n - 1) as f64;
            let i = (fi.floor() as usize).min(n - 2);
            let f = fi - i as f64;
            let a = stem.pts[i];
            let b = stem.pts[i + 1];
            let x0 = a[0] + (b[0] - a[0]) * f;
            let y0 = a[1] + (b[1] - a[1]) * f;
            let m = if k % 2 == 1 { 1.0 } else { -1.0 };
            let height = (0.16 + 0.11 * rand.next()) * (1.12 - 0.3 * c);
            let width = height * (0.85 + 0.25 * rand.next());
            let x = rand.next();
            let mm = if rand.next() < 0.5 { 1.0 } else { -1.0 };
            let (tilt, az, lift);
            if x < 0.18 {
                tilt = 0.26 * rand.next();
                az = 6.28 * rand.next();
                lift = 0.005 + 0.008 * rand.next();
            } else if x < 0.44 {
                tilt = 0.42 * rand.next();
                az = 6.28 * rand.next();
                lift = 0.028 + 0.03 * rand.next();
            } else if x < 0.74 {
                tilt = 0.62 + 0.58 * rand.next();
                az = 1.57 + (rand.next() - 0.5) * 1.2;
                lift = 0.03 + 0.03 * rand.next();
            } else if x < 0.9 {
                tilt = 0.55 + 0.6 * rand.next();
                az = -1.57 + (rand.next() - 0.5) * 1.2;
                lift = 0.028 + 0.025 * rand.next();
            } else {
                tilt = 1.75 + 0.42 * rand.next();
                az = 1.57 * mm + (rand.next() - 0.5) * 0.9;
                lift = 0.028 + 0.02 * rand.next();
            }
            if sdf(x0, y0).d > -0.015 {
                continue;
            }
            let angle = atan2(b[1] - a[1], b[0] - a[0]) + m * (0.82 + 0.52 * rand.next()) - PI / 2.0;
            let mut l = Leaf {
                x: x0,
                y: y0,
                width,
                height,
                angle,
                face: [sin(tilt) * cos(az), sin(tilt) * sin(az), cos(tilt)],
                lift,
                kz: 1.0,
                phase: stem.phase,
                progress: stem.prog[i] + (stem.prog[i + 1] - stem.prog[i]) * f,
                variant: 0.0,
                seed: 0.0,
                side: stem.side,
            };
            l.variant = (6.0 * rand.next()).floor();
            l.seed = 2.0 * PI * rand.next();
            let (mut rmin, mut amax) = (f64::INFINITY, f64::NEG_INFINITY);
            for u in [0.0, 1.0] {
                for v in [0.25, 1.0] {
                    let z = leaf_point(&l, u, v)[2];
                    rmin = rmin.min(z);
                    amax = amax.max(z);
                }
            }
            l.kz = 0.35f64.min(0.071 / (amax - rmin).max(1e-6));
            l.lift = (0.003 - l.kz * rmin).max((0.074 - l.kz * amax).min(l.lift));
            let mid = leaf_point(&l, 0.5, 0.55);
            if mid[0].abs() > 1.72 || mid[1].abs() > 1.1 {
                continue;
            }
            if l.side > 0.0 {
                let mut hit = false;
                for u in [0.0, 0.25, 0.5, 0.75, 1.0] {
                    for v in [0.25, 0.5, 0.75, 1.0] {
                        let p = leaf_point(&l, u, v);
                        if avoid(p[0], p[1], 0.015) {
                            hit = true;
                        }
                    }
                }
                if hit {
                    continue;
                }
            }
            leaves.push(l);
        }
    }
    let stem_leaf_count = leaves.len();

    // Strands: link each stem to the next one starting at its tail on the other side.
    let mut next: Vec<Option<usize>> = vec![None; stems.len()];
    let mut linked = vec![false; stems.len()];
    for (ai, a) in stems.iter().enumerate() {
        for (bi, b) in stems.iter().enumerate() {
            if bi != ai && b.head == a.tail && b.side != a.side && !linked[bi] {
                next[ai] = Some(bi);
                linked[bi] = true;
                break;
            }
        }
    }

    let mut strands: Vec<Vec<StrandNode>> = Vec::new();
    let mut crossings: Vec<StrandNode> = Vec::new();
    for root in 0..stems.len() {
        if linked[root] {
            continue;
        }
        let mut chain: Vec<StrandNode> = Vec::new();
        let mut st = Some(root);
        while let Some(si) = st {
            let nodes = stem_nodes(&stems[si]);
            if !chain.is_empty() && !nodes.is_empty() {
                let a = chain[chain.len() - 1];
                let b = nodes[0];
                crossings.push(a);
                crossings.push(b);
                let sigma = sign(a.p[2]);
                for k in 1..=7 {
                    let r = k as f64 / 8.0;
                    let cosr = cos(PI * r);
                    let sinr = sin(PI * r);
                    let x = a.p[0] + (b.p[0] - a.p[0]) * r;
                    let y = a.p[1] + (b.p[1] - a.p[1]) * r;
                    let e = sdf(x, y);
                    let w = a.width + (b.width - a.width) * r;
                    let hlen = (w / 2.0 + 0.002) * sinr.sqrt() - e.d;
                    chain.push(StrandNode {
                        p: [x + e.nx * hlen, y + e.ny * hlen, sigma * (0.015 + w / 2.0) * sign(cosr) * cosr.abs().sqrt()],
                        n: [e.nx * sinr, e.ny * sinr, sigma * cosr],
                        width: w,
                        progress: a.progress + (b.progress - a.progress) * r,
                        phase: a.phase,
                    });
                }
            }
            chain.extend(nodes);
            st = next[si];
        }
        if chain.len() >= 2 {
            strands.push(chain);
        }
    }

    // Leaves at the edge crossings.
    for node in &crossings {
        if rand.next() < 0.3 {
            continue;
        }
        let e = sdf(node.p[0], node.p[1]);
        let tilt = 0.5 + 0.45 * rand.next();
        let size = 0.13 + 0.07 * rand.next();
        let width = size * (0.85 + 0.25 * rand.next());
        let angle = atan2(-e.nx, e.ny) + (rand.next() - 0.5) * 0.5;
        let variant = (6.0 * rand.next()).floor();
        let seed = 2.0 * PI * rand.next();
        leaves.push(Leaf {
            x: node.p[0],
            y: node.p[1],
            width,
            height: size,
            angle,
            face: [e.nx * sin(tilt), e.ny * sin(tilt), cos(tilt)],
            lift: node.width / 2.0,
            kz: 1.0,
            phase: node.phase,
            progress: node.progress,
            variant,
            seed,
            side: sign(node.p[2]),
        });
    }

    // Stable sort by lift.
    leaves.sort_by(|p, q| p.lift.total_cmp(&q.lift));
    IvyModel { stems, leaves, strands, stem_leaf_count }
}

/// A stem's ribbon nodes on the face (the part inside the card outline), with the edge crossings.
#[allow(clippy::needless_range_loop, reason = "the index loops follow the TypeScript")]
fn stem_nodes(st: &Stem) -> Vec<StrandNode> {
    let n = st.pts.len();
    let width_at = |u: f64| (st.width + (st.end - st.width) * u / (n - 1) as f64).max(0.0034);
    let node = |i: usize, f: f64| -> StrandNode {
        let a = st.pts[i];
        let b = st.pts[(i + 1).min(n - 1)];
        let x = a[0] + (b[0] - a[0]) * f;
        let y = a[1] + (b[1] - a[1]) * f;
        let w = width_at(i as f64 + f);
        let pa = st.prog[i];
        let pb = st.prog[(i + 1).min(n - 1)];
        StrandNode { p: [x, y, st.side * (0.015 + w / 2.0)], n: [0.0, 0.0, st.side], width: w, progress: pa + (pb - pa) * f, phase: st.phase }
    };
    let crossing = |i: usize| -> StrandNode {
        let a = st.pts[i];
        let b = st.pts[i + 1];
        let inside_a = sdf(a[0], a[1]).d < 0.0;
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        for _ in 0..24 {
            let mid = (lo + hi) / 2.0;
            let ins = sdf(a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid).d < 0.0;
            if ins == inside_a {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        node(i, (lo + hi) / 2.0)
    };
    let (mut l, mut s) = (None, 0);
    for i in 0..n {
        if sdf(st.pts[i][0], st.pts[i][1]).d < 0.0 {
            l.get_or_insert(i);
            s = i;
        }
    }
    let Some(l) = l else { return Vec::new() };
    let mut out = Vec::new();
    if l > 0 {
        out.push(crossing(l - 1));
    }
    let mut a_idx: Option<usize> = None;
    for i in l..=s {
        let interior = i > l && i < s;
        if let (true, Some(ai)) = (interior, a_idx) {
            let a = st.pts[ai];
            let b = st.pts[i + 1];
            let cx = b[0] - a[0];
            let cy = b[1] - a[1];
            let chord = hypot(cx, cy);
            if chord < 0.08 {
                let mut collinear = true;
                // `st.pts.indexOf(A)`: the first point equal (by identity) to A, i.e. A's own index.
                let mut j = ai + 1;
                while j <= i && collinear {
                    let p = st.pts[j];
                    let dist = if chord > 1e-9 { ((p[0] - a[0]) * cy - (p[1] - a[1]) * cx).abs() / chord } else { hypot(p[0] - a[0], p[1] - a[1]) };
                    if dist > 0.0012 {
                        collinear = false;
                    }
                    j += 1;
                }
                if collinear {
                    continue;
                }
            }
        }
        out.push(node(i, 0.0));
        a_idx = Some(i);
    }
    if s < n - 1 {
        out.push(crossing(s));
    }
    out
}

/// The main vines kept at `density` (`selectVines`), largest first.
const VINE_ORDER: [usize; 11] = [0, 1, 2, 4, 5, 3, 6, 9, 8, 10, 7];

/// The leaves and strands of the first ⌈density·11⌉ vines of `VINE_ORDER` (all of them at 1).
pub fn select_vines(model: &IvyModel, density: f64) -> (Vec<&Leaf>, Vec<&Vec<StrandNode>>) {
    let total = MAIN_VINES.len();
    let n = ((density * total as f64 - 1e-9).ceil() as i64).clamp(1, total as i64) as usize;
    let keep: Vec<f64> = VINE_ORDER[..n].iter().map(|&a| vine_phase(a)).collect();
    let kept = |phase: f64| n >= total || keep.contains(&phase);
    (model.leaves.iter().filter(|l| kept(l.phase)).collect(), model.strands.iter().filter(|s| !s.is_empty() && kept(s[0].phase)).collect())
}
