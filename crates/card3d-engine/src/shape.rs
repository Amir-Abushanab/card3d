//! Card shapes (`CardDesign.shape`): a port of `geometry/shape.ts` (`geometryForShape`) and the
//! sanitising of `design/sanitize.ts` (`sanitizeShape`). Corner radius within the ISO/IEC 7810 ID-1
//! range, portrait orientation and the cutouts (a lanyard slot, a corner notch, a round window),
//! built procedurally with the standard card's extrusion profile (flat caps, a 2-unit quarter-round
//! bevel, straight walls) on every contour, holes included.
//!
//! Vertices, UVs and normals follow the TypeScript. The caps' triangulation differs (the original
//! uses three's earcut): a small hole-bridging ear clipper here. The caps are planar, so the shading
//! does not depend on it.

use crate::geometry::{Mesh, BODY_SCALE, ID1_BEVEL, ID1_DEPTH};
use crate::iso::{self, MM_PER_UNIT};
use crate::layout::{CardFrame, ID1_BODY_NATIVE};

use crate::json::Value;
use std::f64::consts::{FRAC_PI_2, PI, SQRT_2};

/// ISO/IEC 7810 ID-1 corner radii (mm) and the half short side they are a fraction of.
const CORNER_MM: (f64, f64, f64) = (2.88, 3.18, 3.48);
const CORNER_MM_PER_UNIT: f64 = 53.98 / 2.0;
/// `CORNER_RADIUS_RANGE`: fractions of the pill radius.
pub const CORNER_RADIUS_MIN: f64 = CORNER_MM.0 / CORNER_MM_PER_UNIT;
pub const CORNER_RADIUS_ISO: f64 = CORNER_MM.1 / CORNER_MM_PER_UNIT;
pub const CORNER_RADIUS_MAX: f64 = CORNER_MM.2 / CORNER_MM_PER_UNIT;

/// The cutouts, in the order the TypeScript keeps them.
pub const CARD_CUTOUTS: [&str; 3] = ["lanyard", "notch", "window"];

/// `CardShape`, as `sanitizeShape` leaves it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CardShape {
    /// Fraction of the pill radius (`None`: the ISO nominal).
    pub corner_radius: Option<f64>,
    pub portrait: bool,
    /// Sorted (lanyard, notch, window), unique.
    pub cutouts: Vec<String>,
}

/// `sanitizeShape`: the corner radius rounded to 3 decimals and clamped to the ISO range, portrait,
/// the known cutouts once each. `None` when it is the standard card.
pub fn parse_shape(v: &Value) -> Option<CardShape> {
    let obj = v.as_object()?;
    let mut out = CardShape::default();
    if let Some(r) = obj.get("cornerRadius").and_then(Value::as_f64).filter(|r| r.is_finite()) {
        let r = ((r * 1000.0).round() / 1000.0).clamp(CORNER_RADIUS_MIN, CORNER_RADIUS_MAX);
        if (r - CORNER_RADIUS_ISO).abs() >= 5e-4 {
            out.corner_radius = Some(r);
        }
    }
    out.portrait = obj.get("orientation").and_then(Value::as_str) == Some("portrait");
    if let Some(list) = obj.get("cutouts").and_then(Value::as_array) {
        out.cutouts = CARD_CUTOUTS.iter().filter(|c| list.iter().any(|x| x.as_str() == Some(**c))).map(|c| c.to_string()).collect();
    }
    (out.corner_radius.is_some() || out.portrait || !out.cutouts.is_empty()).then_some(out)
}

/// `resolveShape`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedShape {
    pub corner_radius: f64,
    pub portrait: bool,
    pub cutouts: Vec<String>,
}

/// The shape to build, or `None` when it is the standard card (keep the standard geometry).
pub fn resolve_shape(shape: &CardShape) -> Option<ResolvedShape> {
    let r = shape.corner_radius.filter(|r| r.is_finite()).map_or(CORNER_RADIUS_ISO, |r| r.clamp(CORNER_RADIUS_MIN, CORNER_RADIUS_MAX));
    let cutouts: Vec<String> = CARD_CUTOUTS.iter().filter(|c| shape.cutouts.iter().any(|x| x == *c)).map(|c| c.to_string()).collect();
    if !shape.portrait && cutouts.is_empty() && (r - CORNER_RADIUS_ISO).abs() < 5e-4 {
        return None;
    }
    Some(ResolvedShape { corner_radius: r, portrait: shape.portrait, cutouts })
}

/// A shaped card's geometry (card units): the body, the front and back face planes (the back's cut to
/// the mirrored contours so that, turned by pi about y, it lies over the body's own) and the frame.
pub struct ShapedGeometry {
    pub body: Mesh,
    pub face: Mesh,
    pub back_face: Mesh,
    pub frame: CardFrame,
}

// ── outline description ───────────────────────────────────────────────────────

/// A circular arc of a contour: material on the left of travel. `concave`: material outside the circle.
#[derive(Clone, Copy)]
struct Arc {
    cx: f64,
    cy: f64,
    r: f64,
    a0: f64,
    a1: f64,
    concave: bool,
}

/// Contour sample with its outward normal (away from the material), native units.
#[derive(Clone, Copy)]
struct Sample {
    x: f64,
    y: f64,
    nx: f64,
    ny: f64,
}

type P2 = (f64, f64);

const A: f64 = BODY_SCALE;
const SLOT_LENGTH: f64 = 0.62;
const SLOT_WIDTH: f64 = 0.11;
const NOTCH_RADIUS: f64 = 0.3;
const NOTCH_FILLET: f64 = 0.05;
const WINDOW_RADIUS: f64 = 0.26;

fn sample_arcs(arcs: &[Arc], seg_per_rad: f64) -> Vec<Sample> {
    let mut out = Vec::new();
    for a in arcs {
        let sweep = (a.a1 - a.a0).abs();
        let n = if a.r < 1e-6 { 1 } else { ((sweep * seg_per_rad * (a.r.max(8.0) / 40.0).sqrt()).ceil() as usize).max(2) };
        for k in 0..=n {
            let t = a.a0 + ((a.a1 - a.a0) * k as f64) / n as f64;
            let (c, s) = (t.cos(), t.sin());
            let sign = if a.concave { -1.0 } else { 1.0 };
            out.push(Sample { x: a.cx + a.r * c, y: a.cy + a.r * s, nx: sign * c, ny: sign * s });
        }
    }
    // Drop coincident neighbours (arcs meeting without a straight run, e.g. pill ends).
    let mut dedup: Vec<Sample> = Vec::new();
    for p in out {
        if dedup.last().is_some_and(|q| (p.x - q.x).hypot(p.y - q.y) < 1e-6) {
            continue;
        }
        dedup.push(p);
    }
    if dedup.len() > 1 {
        let (f, l) = (dedup[0], dedup[dedup.len() - 1]);
        if (f.x - l.x).hypot(f.y - l.y) < 1e-6 {
            dedup.pop();
        }
    }
    dedup
}

/// Native outline of the outer edge (counter-clockwise from the bottom-right corner).
fn outer_arcs(w: f64, h: f64, r: f64, notch: bool) -> Vec<Arc> {
    let (hx, hy) = (w / 2.0, h / 2.0);
    let mut arcs = vec![Arc { cx: hx - r, cy: -hy + r, r, a0: -FRAC_PI_2, a1: 0.0, concave: false }];
    if notch {
        // Top-right corner: a quarter-round bite (centre on the corner) with small convex fillets.
        let rn = NOTCH_RADIUS / A;
        let f = NOTCH_FILLET / A;
        let s = (rn * rn + 2.0 * rn * f).sqrt();
        let v = s.atan2(f);
        let u = f.atan2(s);
        arcs.push(Arc { cx: hx - f, cy: hy - s, r: f, a0: 0.0, a1: v, concave: false });
        arcs.push(Arc { cx: hx, cy: hy, r: rn, a0: (-s).atan2(-f) + 2.0 * PI, a1: (-f).atan2(-s) + 2.0 * PI, concave: true });
        arcs.push(Arc { cx: hx - s, cy: hy - f, r: f, a0: u, a1: FRAC_PI_2, concave: false });
    } else {
        arcs.push(Arc { cx: hx - r, cy: hy - r, r, a0: 0.0, a1: FRAC_PI_2, concave: false });
    }
    arcs.push(Arc { cx: -hx + r, cy: hy - r, r, a0: FRAC_PI_2, a1: PI, concave: false });
    arcs.push(Arc { cx: -hx + r, cy: -hy + r, r, a0: PI, a1: 1.5 * PI, concave: false });
    arcs
}

// ISO_CUTOUTS (geometry/iso.ts): where the cutouts go, mm on the landscape card.
const ANTENNA_OUTER: (f64, f64, f64, f64) = (2.0, iso::ID1_WIDTH_MM - 2.0, 13.0, 38.3);
const ANTENNA_TURNS: f64 = 4.0;
const ANTENNA_PITCH: f64 = 0.61;
const ANTENNA_WIRE_RADIUS: f64 = 0.081;

/// `isoAntennaBand().inner`'s left and top edges, mm.
fn antenna_inner_x0_y0() -> (f64, f64) {
    let d = (ANTENNA_TURNS + 0.1) * ANTENNA_PITCH + ANTENNA_WIRE_RADIUS;
    (ANTENNA_OUTER.0 + d, ANTENNA_OUTER.2 + d)
}

/// The lanyard slot: by the left short edge, centred on the card's height (portrait: by the top edge).
/// Returns (x, y, vertical) in card units.
fn slot_placement(portrait: bool) -> (f64, f64, bool) {
    let left = antenna_inner_x0_y0().0 + 0.5;
    let (x, y) = iso::point(left + (SLOT_WIDTH * MM_PER_UNIT) / 2.0, iso::ID1_HEIGHT_MM / 2.0, portrait);
    (x, y, !portrait)
}

/// The round window: centred on the card's width, between the antenna's top run and embossing area 1.
fn window_placement(portrait: bool) -> P2 {
    let y = (antenna_inner_x0_y0().1 + iso::ISO_7811_AREAS.number.y0) / 2.0;
    iso::point(iso::ID1_WIDTH_MM / 2.0, y, portrait)
}

/// Hole outlines (traversed clockwise: material on the left), native units.
fn hole_arcs(s: &ResolvedShape) -> Vec<Vec<Arc>> {
    let mut holes = Vec::new();
    for c in &s.cutouts {
        match c.as_str() {
            "lanyard" => {
                let (x, y, vertical) = slot_placement(s.portrait);
                let hl = (SLOT_LENGTH - SLOT_WIDTH) / 2.0 / A;
                let rr = SLOT_WIDTH / 2.0 / A;
                let (xx, yy) = (x / A, y / A);
                holes.push(if vertical {
                    vec![
                        Arc { cx: xx, cy: yy + hl, r: rr, a0: PI, a1: 0.0, concave: true },
                        Arc { cx: xx, cy: yy - hl, r: rr, a0: 0.0, a1: -PI, concave: true },
                    ]
                } else {
                    vec![
                        Arc { cx: xx + hl, cy: yy, r: rr, a0: FRAC_PI_2, a1: -FRAC_PI_2, concave: true },
                        Arc { cx: xx - hl, cy: yy, r: rr, a0: -FRAC_PI_2, a1: -1.5 * PI, concave: true },
                    ]
                });
            }
            "window" => {
                let (x, y) = window_placement(s.portrait);
                holes.push(vec![Arc { cx: x / A, cy: y / A, r: WINDOW_RADIUS / A, a0: PI, a1: -PI, concave: true }]);
            }
            _ => {}
        }
    }
    holes
}

/// `frameForShape`: the ID-1 body, landscape or portrait, its corner radius, the chip and the cutouts.
pub fn frame_for_shape(s: &ResolvedShape) -> CardFrame {
    let pill = ID1_BODY_NATIVE.width.min(ID1_BODY_NATIVE.height) / 2.0;
    let r_native = (ID1_BEVEL + 0.5).max(s.corner_radius * pill);
    iso::iso_frame(s.portrait, r_native * A, &s.cutouts)
}

// ── geometry ──────────────────────────────────────────────────────────────────

/// Profile rings, front to back: (inset, z).
fn profile_rings(d: f64, b: f64) -> [(f64, f64); 6] {
    let s45 = SQRT_2 / 2.0;
    [
        (b, d / 2.0),
        (b * (1.0 - s45), d / 2.0 - b * (1.0 - s45)),
        (0.0, d / 2.0 - b),
        (0.0, -d / 2.0 + b),
        (b * (1.0 - s45), -d / 2.0 + b * (1.0 - s45)),
        (b, -d / 2.0),
    ]
}

fn inset(p: &Sample, d: f64) -> P2 {
    (p.x - p.nx * d, p.y - p.ny * d)
}

fn cross(a: P2, b: P2, c: P2) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// `BufferGeometry.computeVertexNormals` for indexed geometry (positions rounded to f32 first, as the
/// Float32 attribute holds them).
fn compute_vertex_normals(pos: &[[f64; 3]], index: &[u32]) -> Vec<[f32; 3]> {
    let mut acc = vec![[0.0f64; 3]; pos.len()];
    for t in index.as_chunks::<3>().0 {
        let (a, b, c) = (pos[t[0] as usize], pos[t[1] as usize], pos[t[2] as usize]);
        let cb = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        let ab = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        let n = [cb[1] * ab[2] - cb[2] * ab[1], cb[2] * ab[0] - cb[0] * ab[2], cb[0] * ab[1] - cb[1] * ab[0]];
        for &v in t {
            for k in 0..3 {
                acc[v as usize][k] += n[k];
            }
        }
    }
    acc.iter()
        .map(|n| {
            let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if l > 0.0 {
                [(n[0] / l) as f32, (n[1] / l) as f32, (n[2] / l) as f32]
            } else {
                [0.0, 0.0, 0.0]
            }
        })
        .collect()
}

/// `buildShapedBody`, native units: bevelled walls on every contour, flat caps with holes.
fn build_shaped_body(outer: &[Sample], holes: &[Vec<Sample>], w: f64, h: f64) -> Mesh {
    let (d, b) = (ID1_DEPTH, ID1_BEVEL);
    let rings = profile_rings(d, b);
    let mut pos: Vec<[f64; 3]> = Vec::new();
    let mut uv: Vec<[f32; 2]> = Vec::new();
    let push = |pos: &mut Vec<[f64; 3]>, uv: &mut Vec<[f32; 2]>, x: f64, y: f64, z: f64| {
        // Positions live in a Float32 attribute.
        pos.push([x as f32 as f64, y as f32 as f64, z as f32 as f64]);
        let (u, v) = ((x + w / 2.0) / w, (y + h / 2.0) / h);
        uv.push(if z >= 0.0 { [u as f32, v as f32] } else { [v as f32, u as f32] });
    };
    let mut index: Vec<u32> = Vec::new();
    for contour in std::iter::once(outer).chain(holes.iter().map(|h| h.as_slice())) {
        let n = contour.len();
        let start = pos.len();
        for &(ins, z) in &rings {
            for p in contour {
                let q = inset(p, ins);
                push(&mut pos, &mut uv, q.0, q.1, z);
            }
        }
        for r in 0..rings.len() - 1 {
            let a0 = (start + r * n) as u32;
            let b0 = (start + (r + 1) * n) as u32;
            for i in 0..n as u32 {
                let j = (i + 1) % n as u32;
                index.extend([a0 + i, b0 + i, b0 + j, a0 + i, b0 + j, a0 + j]);
            }
        }
    }
    // Caps (split vertices, like the standard body): triangulated with the holes.
    let cap: Vec<P2> = outer.iter().map(|p| inset(p, b)).collect();
    let cap_holes: Vec<Vec<P2>> = holes.iter().map(|hl| hl.iter().map(|p| inset(p, b)).collect()).collect();
    let tris = triangulate(&cap, &cap_holes);
    let all: Vec<P2> = cap.iter().copied().chain(cap_holes.iter().flatten().copied()).collect();
    for front in [true, false] {
        let base = pos.len() as u32;
        for p in &all {
            push(&mut pos, &mut uv, p.0, p.1, if front { d / 2.0 } else { -d / 2.0 });
        }
        for &[p, q, r] in &tris {
            let ccw = cross(all[p], all[q], all[r]) >= 0.0;
            let (i1, i2) = if ccw == front { (q, r) } else { (r, q) };
            index.extend([base + p as u32, base + i1 as u32, base + i2 as u32]);
        }
    }
    let normals = compute_vertex_normals(&pos, &index);
    Mesh { positions: pos.iter().map(|p| [(p[0] * A) as f32, (p[1] * A) as f32, (p[2] * A) as f32]).collect(), normals, uvs: uv, indices: index }
}

/// A flat +z polygon with holes (card units) and UVs from `uv_of` (`flatShapeGeometry`).
fn flat_shape(outer: &[P2], holes: &[Vec<P2>], uv_of: impl Fn(f64, f64) -> [f64; 2]) -> Mesh {
    let tris = triangulate(outer, holes);
    let all: Vec<P2> = outer.iter().copied().chain(holes.iter().flatten().copied()).collect();
    let mut m = Mesh::default();
    for p in &all {
        m.positions.push([p.0 as f32, p.1 as f32, 0.0]);
        m.normals.push([0.0, 0.0, 1.0]);
        let [u, v] = uv_of(p.0, p.1);
        m.uvs.push([u as f32, v as f32]);
    }
    for [a, b, c] in tris {
        if cross(all[a], all[b], all[c]) >= 0.0 {
            m.indices.extend([a as u32, b as u32, c as u32]);
        } else {
            m.indices.extend([a as u32, c as u32, b as u32]);
        }
    }
    m
}

/// The shape's geometry set (`buildShapedCardGeometry`'s body, face and back face, and the frame), or
/// `None` for the standard card.
/// `geometry_for_shape` behind a split point: on the web it lives in the `shape` chunk, which
/// downloads only for shaped cards. Natively it is a direct call.
#[wasm_split_helpers::wasm_split(shape, fallible)]
pub fn geometry_for_shape_lazy(shape: &CardShape) -> Result<Option<ShapedGeometry>, crate::ChunkUnavailable> {
    Ok(geometry_for_shape(shape))
}

pub fn geometry_for_shape(shape: &CardShape) -> Option<ShapedGeometry> {
    let s = resolve_shape(shape)?;
    let frame = frame_for_shape(&s);
    let (w, h) = (frame.body_width / A, frame.body_height / A);
    let seg_per_rad = 12.0 / FRAC_PI_2;
    let notch = s.cutouts.iter().any(|c| c == "notch");
    let outer = sample_arcs(&outer_arcs(w, h, frame.corner_radius / A, notch), seg_per_rad);
    let holes: Vec<Vec<Sample>> = hole_arcs(&s).iter().map(|arcs| sample_arcs(arcs, seg_per_rad)).collect();

    let body = build_shaped_body(&outer, &holes, w, h);

    let to_card = |pts: &[Sample], d: f64| -> Vec<P2> { pts.iter().map(|p| inset(p, d)).map(|(x, y)| (x * A, y * A)).collect() };
    // Face plane: just outside the cap edge, UV 0..1 over its box.
    let face_outer = to_card(&outer, 1.0);
    let face_holes: Vec<Vec<P2>> = holes.iter().map(|hl| to_card(hl, 1.0)).collect();
    let (mut lo, mut hi) = ((f64::INFINITY, f64::INFINITY), (f64::NEG_INFINITY, f64::NEG_INFINITY));
    for p in &face_outer {
        lo = (lo.0.min(p.0), lo.1.min(p.1));
        hi = (hi.0.max(p.0), hi.1.max(p.1));
    }
    let (fw, fh) = (hi.0 - lo.0, hi.1 - lo.1);
    let face_uv = |x: f64, y: f64| [(x - lo.0) / fw, (y - lo.1) / fh];
    let face = flat_shape(&face_outer, &face_holes, face_uv);
    // The back's plane, cut to the mirrored contours (the order is kept, so the winding flips; the
    // triangles are re-wound to face +z).
    let mirror = |pts: &[P2]| -> Vec<P2> { pts.iter().map(|p| (-p.0, p.1)).collect() };
    let mirrored_holes: Vec<Vec<P2>> = face_holes.iter().map(|hl| mirror(hl)).collect();
    let back_face = flat_shape(&mirror(&face_outer), &mirrored_holes, face_uv);
    Some(ShapedGeometry { body, face, back_face, frame })
}

// ── triangulation ─────────────────────────────────────────────────────────────

fn area(poly: &[P2]) -> f64 {
    let n = poly.len();
    (0..n).map(|i| (poly[i].0 * poly[(i + 1) % n].1) - (poly[(i + 1) % n].0 * poly[i].1)).sum::<f64>() / 2.0
}

fn same(a: P2, b: P2) -> bool {
    (a.0 - b.0).abs() < 1e-12 && (a.1 - b.1).abs() < 1e-12
}

/// Whether the closed segments p-q and r-s intersect (touching counts).
fn segments_meet(p: P2, q: P2, r: P2, s: P2) -> bool {
    let (o1, o2, o3, o4) = (cross(p, q, r), cross(p, q, s), cross(r, s, p), cross(r, s, q));
    if o1 * o2 < 0.0 && o3 * o4 < 0.0 {
        return true;
    }
    let on = |a: P2, b: P2, c: P2| c.0 >= a.0.min(b.0) - 1e-12 && c.0 <= a.0.max(b.0) + 1e-12 && c.1 >= a.1.min(b.1) - 1e-12 && c.1 <= a.1.max(b.1) + 1e-12;
    (o1 == 0.0 && on(p, q, r)) || (o2 == 0.0 && on(p, q, s)) || (o3 == 0.0 && on(r, s, p)) || (o4 == 0.0 && on(r, s, q))
}

/// Whether the segment pa-pb crosses any of `edges` (those touching its endpoints do not count).
fn blocked(pa: P2, pb: P2, mut edges: impl Iterator<Item = (P2, P2)>) -> bool {
    edges.any(|(e0, e1)| !(same(e0, pa) || same(e1, pa) || same(e0, pb) || same(e1, pb)) && segments_meet(pa, pb, e0, e1))
}

fn inside_ring(pt: P2, ring: &[P2]) -> bool {
    let mut inside = false;
    let n = ring.len();
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        if (a.1 > pt.1) != (b.1 > pt.1) && pt.0 < (b.0 - a.0) * (pt.1 - a.1) / (b.1 - a.1) + a.0 {
            inside = !inside;
        }
    }
    inside
}

/// Triangles (indices into `outer` followed by every hole's points) of a polygon with holes: holes are
/// joined to the outline by the shortest unobstructed bridge, then ears are clipped.
fn triangulate(outer: &[P2], holes: &[Vec<P2>]) -> Vec<[usize; 3]> {
    let pts: Vec<P2> = outer.iter().copied().chain(holes.iter().flatten().copied()).collect();
    let mut poly: Vec<usize> = (0..outer.len()).collect();
    if area(outer) < 0.0 {
        poly.reverse();
    }
    let mut rings: Vec<Vec<usize>> = Vec::new();
    let mut off = outer.len();
    for hl in holes {
        let mut ring: Vec<usize> = (off..off + hl.len()).collect();
        if area(hl) > 0.0 {
            ring.reverse();
        }
        rings.push(ring);
        off += hl.len();
    }
    // Every contour as a point ring, for the inside test and the obstruction checks.
    let contour_pts: Vec<Vec<P2>> = std::iter::once(outer.to_vec()).chain(holes.iter().cloned()).collect();
    let in_region = |p: P2| inside_ring(p, &contour_pts[0]) && !contour_pts[1..].iter().any(|h| inside_ring(p, h));
    let pts_r = &pts;
    for k in 0..rings.len() {
        let ring = rings[k].clone();
        // Candidate bridges, shortest first.
        let mut cands: Vec<(f64, usize, usize)> = Vec::new();
        for (pi, &a) in poly.iter().enumerate() {
            for (hj, &b) in ring.iter().enumerate() {
                let (pa, pb) = (pts[a], pts[b]);
                cands.push(((pa.0 - pb.0).powi(2) + (pa.1 - pb.1).powi(2), pi, hj));
            }
        }
        cands.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut chosen = None;
        for &(_, pi, hj) in &cands {
            let (pa, pb) = (pts[poly[pi]], pts[ring[hj]]);
            if !in_region(((pa.0 + pb.0) / 2.0, (pa.1 + pb.1) / 2.0)) {
                continue;
            }
            let edges = poly.iter().enumerate().map(|(i, &a)| (pts[a], pts[poly[(i + 1) % poly.len()]]));
            if blocked(pa, pb, edges) {
                continue;
            }
            // The hole itself and the holes still to be joined.
            let others = rings[k..].iter().flat_map(|r| r.iter().enumerate().map(move |(i, &a)| (pts_r[a], pts_r[r[(i + 1) % r.len()]])));
            if blocked(pa, pb, others) {
                continue;
            }
            chosen = Some((pi, hj));
            break;
        }
        let (pi, hj) = chosen.unwrap_or((0, 0));
        let mut joined: Vec<usize> = poly[..=pi].to_vec();
        joined.extend(ring[hj..].iter().chain(ring[..=hj].iter()).copied());
        joined.push(poly[pi]);
        joined.extend(poly[pi + 1..].iter().copied());
        poly = joined;
    }
    clip_ears(&pts, poly)
}

/// Ear clipping of a counter-clockwise weakly simple polygon (bridged holes repeat their vertices).
fn clip_ears(pts: &[P2], mut poly: Vec<usize>) -> Vec<[usize; 3]> {
    let mut tris = Vec::new();
    let in_tri = |p: P2, a: P2, b: P2, c: P2| cross(a, b, p) >= -1e-14 && cross(b, c, p) >= -1e-14 && cross(c, a, p) >= -1e-14;
    while poly.len() > 3 {
        let n = poly.len();
        let mut pick = None;
        'strict: for strict in [true, false] {
            for i in 0..n {
                let (ia, ib, ic) = (poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]);
                let (a, b, c) = (pts[ia], pts[ib], pts[ic]);
                let cr = cross(a, b, c);
                if if strict { cr <= 1e-14 } else { cr < -1e-14 } {
                    continue;
                }
                let blocked = poly.iter().any(|&j| {
                    let p = pts[j];
                    !(same(p, a) || same(p, b) || same(p, c)) && in_tri(p, a, b, c)
                });
                if !blocked || !strict {
                    pick = Some(i);
                    break 'strict;
                }
            }
        }
        let i = pick.unwrap_or(0);
        tris.push([poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]]);
        poly.remove(i);
    }
    if poly.len() == 3 {
        tris.push([poly[0], poly[1], poly[2]]);
    }
    tris
}
