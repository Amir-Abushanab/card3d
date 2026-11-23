//! three.js r180's shape, extrusion and tube machinery, ported operation for operation so the vertices
//! match three's (the glass body and the chip module are built from them): `Path` /
//! `Shape` (lines, quadratic curves and `absarc` ellipse arcs, `getPoints` with its duplicate-point rules), `ShapeUtils.triangulateShape`
//! with three's Earcut (`extras/lib/earcut.js`), `ExtrudeGeometry` with `WorldUVGenerator`,
//! `CatmullRomCurve3` + `Curve` (arc-length mapping, Frenet frames) + `TubeGeometry`, and the
//! `BufferGeometry` helpers `translate`, `center` and `computeVertexNormals` (non-indexed).
//!
//! Arithmetic is f64 like JavaScript's; attributes are stored as f32 like three's `Float32BufferAttribute`.
//! Not ported (nothing here needs them): shapes with holes in `ExtrudeGeometry` (Earcut itself handles
//! holes), `extrudePath`, a custom UV generator, the other curve types, `ExtrudeGeometry` groups.

use crate::geometry::Mesh;
use glam::{DVec2, DVec3};
use std::cell::OnceCell;
use std::f64::consts::PI;

// ── Path / Shape ────────────────────────────────────────────────────────────

/// A curve of a [`Path`]: `LineCurve`, `EllipseCurve` or `QuadraticBezierCurve`.
#[derive(Clone, Copy, Debug)]
pub enum Curve2 {
    Line { v1: DVec2, v2: DVec2 },
    Quadratic { v0: DVec2, v1: DVec2, v2: DVec2 },
    Ellipse { x: f64, y: f64, x_radius: f64, y_radius: f64, start: f64, end: f64, clockwise: bool, rotation: f64 },
}

impl Curve2 {
    /// `LineCurve.getPoint` / `EllipseCurve.getPoint`.
    pub fn point(&self, t: f64) -> DVec2 {
        match *self {
            Curve2::Line { v1, v2 } => {
                if t == 1.0 {
                    v2
                } else {
                    DVec2::new((v2.x - v1.x) * t + v1.x, (v2.y - v1.y) * t + v1.y)
                }
            }
            Curve2::Quadratic { v0, v1, v2 } => {
                // `Interpolations.QuadraticBezier`, term by term.
                let q = |p0: f64, p1: f64, p2: f64| {
                    let k = 1.0 - t;
                    k * k * p0 + 2.0 * (1.0 - t) * t * p1 + t * t * p2
                };
                DVec2::new(q(v0.x, v1.x, v2.x), q(v0.y, v1.y, v2.y))
            }
            Curve2::Ellipse { x: ax, y: ay, x_radius, y_radius, start, end, clockwise, rotation } => {
                let two_pi = PI * 2.0;
                let mut delta = end - start;
                let same_points = delta.abs() < f64::EPSILON;
                while delta < 0.0 {
                    delta += two_pi;
                }
                while delta > two_pi {
                    delta -= two_pi;
                }
                if delta < f64::EPSILON {
                    delta = if same_points { 0.0 } else { two_pi };
                }
                if clockwise && !same_points {
                    delta = if delta == two_pi { -two_pi } else { delta - two_pi };
                }
                let angle = start + t * delta;
                let mut x = ax + x_radius * angle.cos();
                let mut y = ay + y_radius * angle.sin();
                if rotation != 0.0 {
                    let (cos, sin) = (rotation.cos(), rotation.sin());
                    let (tx, ty) = (x - ax, y - ay);
                    x = tx * cos - ty * sin + ax;
                    y = tx * sin + ty * cos + ay;
                }
                DVec2::new(x, y)
            }
        }
    }

    /// `Curve.getPoints(divisions)`: `divisions + 1` points at even parameter steps.
    fn points(&self, divisions: usize) -> Vec<DVec2> {
        (0..=divisions).map(|d| self.point(d as f64 / divisions as f64)).collect()
    }
}

/// `THREE.Shape` (without holes) / `THREE.Path`: connected lines and arcs.
#[derive(Clone, Debug, Default)]
pub struct Shape {
    pub curves: Vec<Curve2>,
    current: DVec2,
}

impl Shape {
    pub fn new() -> Shape {
        Shape::default()
    }

    pub fn move_to(&mut self, x: f64, y: f64) -> &mut Self {
        self.current = DVec2::new(x, y);
        self
    }

    pub fn line_to(&mut self, x: f64, y: f64) -> &mut Self {
        self.curves.push(Curve2::Line { v1: self.current, v2: DVec2::new(x, y) });
        self.current = DVec2::new(x, y);
        self
    }

    /// `Path.quadraticCurveTo`.
    pub fn quadratic_curve_to(&mut self, cx: f64, cy: f64, x: f64, y: f64) -> &mut Self {
        self.curves.push(Curve2::Quadratic { v0: self.current, v1: DVec2::new(cx, cy), v2: DVec2::new(x, y) });
        self.current = DVec2::new(x, y);
        self
    }

    /// `CurvePath.closePath`: a line back to the first curve's start, unless already there.
    pub fn close_path(&mut self) -> &mut Self {
        if let (Some(first), Some(last)) = (self.curves.first(), self.curves.last()) {
            let (start, end) = (first.point(0.0), last.point(1.0));
            if start != end {
                self.curves.push(Curve2::Line { v1: end, v2: start });
            }
        }
        self
    }

    /// `Path.absarc`.
    pub fn absarc(&mut self, x: f64, y: f64, radius: f64, start: f64, end: f64, clockwise: bool) -> &mut Self {
        self.absellipse(x, y, radius, radius, start, end, clockwise, 0.0)
    }

    /// `Path.absellipse`: joins the previous curve with a line when the arc's first point is not exactly the current point.
    pub fn absellipse(&mut self, x: f64, y: f64, x_radius: f64, y_radius: f64, start: f64, end: f64, clockwise: bool, rotation: f64) -> &mut Self {
        let curve = Curve2::Ellipse { x, y, x_radius, y_radius, start, end, clockwise, rotation };
        if !self.curves.is_empty() {
            let first = curve.point(0.0);
            if first != self.current {
                self.line_to(first.x, first.y);
            }
        }
        self.curves.push(curve);
        self.current = curve.point(1.0);
        self
    }

    /// `CurvePath.getPoints(divisions)`: ellipse arcs take `2 * divisions` steps, lines one, other curves
    /// `divisions`; a point equal
    /// to the previous one is skipped.
    pub fn get_points(&self, divisions: usize) -> Vec<DVec2> {
        let mut points: Vec<DVec2> = Vec::new();
        let mut last: Option<DVec2> = None;
        for curve in &self.curves {
            let resolution = match curve {
                Curve2::Ellipse { .. } => divisions * 2,
                Curve2::Line { .. } => 1,
                Curve2::Quadratic { .. } => divisions,
            };
            for p in curve.points(resolution) {
                if last == Some(p) {
                    continue;
                }
                points.push(p);
                last = Some(p);
            }
        }
        points
    }
}

// ── Earcut ──────────────────────────────────────────────────────────────────

/// `ShapeUtils.area`.
pub fn area(contour: &[DVec2]) -> f64 {
    let n = contour.len();
    let mut a = 0.0;
    let mut p = n.wrapping_sub(1);
    for q in 0..n {
        a += contour[p].x * contour[q].y - contour[q].x * contour[p].y;
        p = q;
    }
    a * 0.5
}

/// `ShapeUtils.isClockWise`.
pub fn is_clockwise(pts: &[DVec2]) -> bool {
    area(pts) < 0.0
}

/// `ShapeUtils.triangulateShape`: the contour's and holes' trailing duplicate of the first point is dropped
/// (in place, as three does), then Earcut runs on the contour followed by the holes. Triangles of indices
/// into `contour ++ holes`.
pub fn triangulate_shape(contour: &mut Vec<DVec2>, holes: &mut [Vec<DVec2>]) -> Vec<[usize; 3]> {
    fn remove_dup_end_pts(points: &mut Vec<DVec2>) {
        let l = points.len();
        if l > 2 && points[l - 1] == points[0] {
            points.pop();
        }
    }
    remove_dup_end_pts(contour);
    let mut vertices: Vec<f64> = contour.iter().flat_map(|p| [p.x, p.y]).collect();
    let mut hole_indices = Vec::new();
    let mut hole_index = contour.len();
    for h in holes.iter_mut() {
        remove_dup_end_pts(h);
    }
    for h in holes.iter() {
        hole_indices.push(hole_index);
        hole_index += h.len();
        vertices.extend(h.iter().flat_map(|p| [p.x, p.y]));
    }
    earcut(&vertices, &hole_indices, 2).as_chunks::<3>().0.to_vec()
}

const NIL: usize = usize::MAX;

struct EcNode {
    i: usize,
    x: f64,
    y: f64,
    prev: usize,
    next: usize,
    z: i32,
    prev_z: usize,
    next_z: usize,
    steiner: bool,
}

/// three's Earcut (mapbox/earcut 3.x as vendored in `extras/lib/earcut.js`): the same linked-list
/// polygon with z-order hashing above 80 vertices, so the triangles come out in three's order.
/// `data` is a flat `[x0, y0, ...]` array, `hole_indices` the vertex index where each hole starts.
pub fn earcut(data: &[f64], hole_indices: &[usize], dim: usize) -> Vec<usize> {
    let has_holes = !hole_indices.is_empty();
    let outer_len = if has_holes { hole_indices[0] * dim } else { data.len() };
    let mut ec = Earcut { nodes: Vec::new() };
    let mut outer = ec.linked_list(data, 0, outer_len, dim, true);
    let mut triangles = Vec::new();
    if outer == NIL || ec.nodes[outer].next == ec.nodes[outer].prev {
        return triangles;
    }
    let (mut min_x, mut min_y, mut inv_size) = (0.0, 0.0, 0.0);
    if has_holes {
        outer = ec.eliminate_holes(data, hole_indices, outer, dim);
    }
    // If the shape is not too simple, we'll use z-order curve hash later; calculate polygon bbox.
    if data.len() > 80 * dim {
        min_x = f64::INFINITY;
        min_y = f64::INFINITY;
        let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        let mut i = dim;
        while i < outer_len {
            let (x, y) = (data[i], data[i + 1]);
            if x < min_x {
                min_x = x;
            }
            if y < min_y {
                min_y = y;
            }
            if x > max_x {
                max_x = x;
            }
            if y > max_y {
                max_y = y;
            }
            i += dim;
        }
        // minX, minY and invSize are later used to transform coords into integers for z-order calculation.
        inv_size = (max_x - min_x).max(max_y - min_y);
        inv_size = if inv_size != 0.0 { 32767.0 / inv_size } else { 0.0 };
    }
    ec.earcut_linked(outer, &mut triangles, min_x, min_y, inv_size, 0);
    triangles
}

struct Earcut {
    nodes: Vec<EcNode>,
}

impl Earcut {
    fn create_node(&mut self, i: usize, x: f64, y: f64) -> usize {
        self.nodes.push(EcNode { i, x, y, prev: NIL, next: NIL, z: 0, prev_z: NIL, next_z: NIL, steiner: false });
        self.nodes.len() - 1
    }

    fn insert_node(&mut self, i: usize, x: f64, y: f64, last: usize) -> usize {
        let p = self.create_node(i, x, y);
        if last == NIL {
            self.nodes[p].prev = p;
            self.nodes[p].next = p;
        } else {
            let ln = self.nodes[last].next;
            self.nodes[p].next = ln;
            self.nodes[p].prev = last;
            self.nodes[ln].prev = p;
            self.nodes[last].next = p;
        }
        p
    }

    fn remove_node(&mut self, p: usize) {
        let (prev, next, pz, nz) = (self.nodes[p].prev, self.nodes[p].next, self.nodes[p].prev_z, self.nodes[p].next_z);
        self.nodes[next].prev = prev;
        self.nodes[prev].next = next;
        if pz != NIL {
            self.nodes[pz].next_z = nz;
        }
        if nz != NIL {
            self.nodes[nz].prev_z = pz;
        }
    }

    /// Creates a circular doubly linked list from polygon points in the specified winding order.
    fn linked_list(&mut self, data: &[f64], start: usize, end: usize, dim: usize, clockwise: bool) -> usize {
        let mut last = NIL;
        if clockwise == (signed_area(data, start, end, dim) > 0.0) {
            let mut i = start;
            while i < end {
                last = self.insert_node(i / dim, data[i], data[i + 1], last);
                i += dim;
            }
        } else {
            let mut i = end as isize - dim as isize;
            while i >= start as isize {
                let u = i as usize;
                last = self.insert_node(u / dim, data[u], data[u + 1], last);
                i -= dim as isize;
            }
        }
        if last != NIL && self.equals(last, self.nodes[last].next) {
            self.remove_node(last);
            last = self.nodes[last].next;
        }
        last
    }

    fn equals(&self, a: usize, b: usize) -> bool {
        self.nodes[a].x == self.nodes[b].x && self.nodes[a].y == self.nodes[b].y
    }

    /// Signed area of the triangle p, q, r.
    fn area(&self, p: usize, q: usize, r: usize) -> f64 {
        let (p, q, r) = (&self.nodes[p], &self.nodes[q], &self.nodes[r]);
        (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
    }

    /// Eliminates collinear or duplicate points.
    fn filter_points(&mut self, start: usize, end: Option<usize>) -> usize {
        if start == NIL {
            return start;
        }
        let mut end = end.unwrap_or(start);
        let mut p = start;
        loop {
            let mut again = false;
            let next = self.nodes[p].next;
            if !self.nodes[p].steiner && (self.equals(p, next) || self.area(self.nodes[p].prev, p, next) == 0.0) {
                self.remove_node(p);
                p = self.nodes[p].prev;
                end = p;
                if p == self.nodes[p].next {
                    break;
                }
                again = true;
            } else {
                p = next;
            }
            if !(again || p != end) {
                break;
            }
        }
        end
    }

    /// Main ear slicing loop which triangulates a polygon (given as a linked list).
    fn earcut_linked(&mut self, mut ear: usize, triangles: &mut Vec<usize>, min_x: f64, min_y: f64, inv_size: f64, pass: u8) {
        if ear == NIL {
            return;
        }
        // Interlink polygon nodes in z-order.
        if pass == 0 && inv_size != 0.0 {
            self.index_curve(ear, min_x, min_y, inv_size);
        }
        let mut stop = ear;
        while self.nodes[ear].prev != self.nodes[ear].next {
            let (prev, next) = (self.nodes[ear].prev, self.nodes[ear].next);
            let is_ear = if inv_size != 0.0 { self.is_ear_hashed(ear, min_x, min_y, inv_size) } else { self.is_ear(ear) };
            if is_ear {
                triangles.extend([self.nodes[prev].i, self.nodes[ear].i, self.nodes[next].i]);
                self.remove_node(ear);
                // Skipping the next vertex leads to less sliver triangles.
                ear = self.nodes[next].next;
                stop = self.nodes[next].next;
                continue;
            }
            ear = next;
            // If we looped through the whole remaining polygon and can't find any more ears.
            if ear == stop {
                match pass {
                    0 => {
                        let f = self.filter_points(ear, None);
                        self.earcut_linked(f, triangles, min_x, min_y, inv_size, 1);
                    }
                    1 => {
                        let f = self.filter_points(ear, None);
                        ear = self.cure_local_intersections(f, triangles);
                        self.earcut_linked(ear, triangles, min_x, min_y, inv_size, 2);
                    }
                    2 => self.split_earcut(ear, triangles, min_x, min_y, inv_size),
                    _ => {}
                }
                break;
            }
        }
    }

    fn is_ear(&self, ear: usize) -> bool {
        let (a, b, c) = (self.nodes[ear].prev, ear, self.nodes[ear].next);
        if self.area(a, b, c) >= 0.0 {
            return false;
        }
        let (ax, bx, cx, ay, by, cy) = (self.nodes[a].x, self.nodes[b].x, self.nodes[c].x, self.nodes[a].y, self.nodes[b].y, self.nodes[c].y);
        let x0 = ax.min(bx).min(cx);
        let y0 = ay.min(by).min(cy);
        let x1 = ax.max(bx).max(cx);
        let y1 = ay.max(by).max(cy);
        let mut p = self.nodes[c].next;
        while p != a {
            let n = &self.nodes[p];
            if n.x >= x0
                && n.x <= x1
                && n.y >= y0
                && n.y <= y1
                && point_in_triangle_except_first(ax, ay, bx, by, cx, cy, n.x, n.y)
                && self.area(n.prev, p, n.next) >= 0.0
            {
                return false;
            }
            p = n.next;
        }
        true
    }

    fn is_ear_hashed(&self, ear: usize, min_x: f64, min_y: f64, inv_size: f64) -> bool {
        let (a, b, c) = (self.nodes[ear].prev, ear, self.nodes[ear].next);
        if self.area(a, b, c) >= 0.0 {
            return false;
        }
        let (ax, bx, cx, ay, by, cy) = (self.nodes[a].x, self.nodes[b].x, self.nodes[c].x, self.nodes[a].y, self.nodes[b].y, self.nodes[c].y);
        let x0 = ax.min(bx).min(cx);
        let y0 = ay.min(by).min(cy);
        let x1 = ax.max(bx).max(cx);
        let y1 = ay.max(by).max(cy);
        // z-order range for the current triangle's bbox.
        let min_z = z_order(x0, y0, min_x, min_y, inv_size);
        let max_z = z_order(x1, y1, min_x, min_y, inv_size);
        let blocks = |p: usize| {
            let n = &self.nodes[p];
            n.x >= x0
                && n.x <= x1
                && n.y >= y0
                && n.y <= y1
                && p != a
                && p != c
                && point_in_triangle_except_first(ax, ay, bx, by, cx, cy, n.x, n.y)
                && self.area(n.prev, p, n.next) >= 0.0
        };
        let mut p = self.nodes[ear].prev_z;
        let mut n = self.nodes[ear].next_z;
        // Look for points inside the triangle in both directions.
        while p != NIL && self.nodes[p].z >= min_z && n != NIL && self.nodes[n].z <= max_z {
            if blocks(p) {
                return false;
            }
            p = self.nodes[p].prev_z;
            if blocks(n) {
                return false;
            }
            n = self.nodes[n].next_z;
        }
        // Look for remaining points in decreasing z-order.
        while p != NIL && self.nodes[p].z >= min_z {
            if blocks(p) {
                return false;
            }
            p = self.nodes[p].prev_z;
        }
        // Look for remaining points in increasing z-order.
        while n != NIL && self.nodes[n].z <= max_z {
            if blocks(n) {
                return false;
            }
            n = self.nodes[n].next_z;
        }
        true
    }

    /// Goes through all polygon nodes and cures small local self-intersections.
    fn cure_local_intersections(&mut self, mut start: usize, triangles: &mut Vec<usize>) -> usize {
        let mut p = start;
        loop {
            let a = self.nodes[p].prev;
            let pn = self.nodes[p].next;
            let b = self.nodes[pn].next;
            if !self.equals(a, b) && self.intersects(a, p, pn, b) && self.locally_inside(a, b) && self.locally_inside(b, a) {
                triangles.extend([self.nodes[a].i, self.nodes[p].i, self.nodes[b].i]);
                self.remove_node(p);
                let pn = self.nodes[p].next;
                self.remove_node(pn);
                p = b;
                start = b;
            }
            p = self.nodes[p].next;
            if p == start {
                break;
            }
        }
        self.filter_points(p, None)
    }

    /// Splits the polygon into two and tries to triangulate them independently.
    fn split_earcut(&mut self, start: usize, triangles: &mut Vec<usize>, min_x: f64, min_y: f64, inv_size: f64) {
        let mut a = start;
        loop {
            let mut b = self.nodes[self.nodes[a].next].next;
            while b != self.nodes[a].prev {
                if self.nodes[a].i != self.nodes[b].i && self.is_valid_diagonal(a, b) {
                    let mut c = self.split_polygon(a, b);
                    let an = self.nodes[a].next;
                    a = self.filter_points(a, Some(an));
                    let cn = self.nodes[c].next;
                    c = self.filter_points(c, Some(cn));
                    self.earcut_linked(a, triangles, min_x, min_y, inv_size, 0);
                    self.earcut_linked(c, triangles, min_x, min_y, inv_size, 0);
                    return;
                }
                b = self.nodes[b].next;
            }
            a = self.nodes[a].next;
            if a == start {
                break;
            }
        }
    }

    /// Links every hole into the outer loop, producing a single-ring polygon without holes.
    fn eliminate_holes(&mut self, data: &[f64], hole_indices: &[usize], mut outer: usize, dim: usize) -> usize {
        let mut queue = Vec::new();
        for (i, &h) in hole_indices.iter().enumerate() {
            let start = h * dim;
            let end = if i + 1 < hole_indices.len() { hole_indices[i + 1] * dim } else { data.len() };
            let list = self.linked_list(data, start, end, dim, false);
            if list == self.nodes[list].next {
                self.nodes[list].steiner = true;
            }
            queue.push(self.get_leftmost(list));
        }
        queue.sort_by(|&a, &b| self.compare_xy_slope(a, b).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
        for h in queue {
            outer = self.eliminate_hole(h, outer);
        }
        outer
    }

    fn compare_xy_slope(&self, a: usize, b: usize) -> f64 {
        let (na, nb) = (&self.nodes[a], &self.nodes[b]);
        let mut result = na.x - nb.x;
        if result == 0.0 {
            result = na.y - nb.y;
            if result == 0.0 {
                let (ax, bx) = (&self.nodes[na.next], &self.nodes[nb.next]);
                let a_slope = (ax.y - na.y) / (ax.x - na.x);
                let b_slope = (bx.y - nb.y) / (bx.x - nb.x);
                result = a_slope - b_slope;
            }
        }
        result
    }

    /// Finds a bridge between vertices that connects a hole with an outer ring and links it.
    fn eliminate_hole(&mut self, hole: usize, outer: usize) -> usize {
        let bridge = self.find_hole_bridge(hole, outer);
        if bridge == NIL {
            return outer;
        }
        let bridge_reverse = self.split_polygon(bridge, hole);
        // Filter collinear points around the cuts.
        let br_next = self.nodes[bridge_reverse].next;
        self.filter_points(bridge_reverse, Some(br_next));
        let b_next = self.nodes[bridge].next;
        self.filter_points(bridge, Some(b_next))
    }

    /// David Eberly's algorithm for finding a bridge between hole and outer polygon.
    fn find_hole_bridge(&self, hole: usize, outer: usize) -> usize {
        let mut p = outer;
        let (hx, hy) = (self.nodes[hole].x, self.nodes[hole].y);
        let mut qx = f64::NEG_INFINITY;
        let mut m = NIL;
        // Find a segment intersected by a ray from the hole's leftmost point to the left;
        // segment's endpoint with lesser x will be potential connection point.
        if self.equals(hole, p) {
            return p;
        }
        loop {
            let pn = self.nodes[p].next;
            if self.equals(hole, pn) {
                return pn;
            } else if hy <= self.nodes[p].y && hy >= self.nodes[pn].y && self.nodes[pn].y != self.nodes[p].y {
                let x = self.nodes[p].x + (hy - self.nodes[p].y) * (self.nodes[pn].x - self.nodes[p].x) / (self.nodes[pn].y - self.nodes[p].y);
                if x <= hx && x > qx {
                    qx = x;
                    m = if self.nodes[p].x < self.nodes[pn].x { p } else { pn };
                    if x == hx {
                        // Hole touches outer segment; pick leftmost endpoint.
                        return m;
                    }
                }
            }
            p = pn;
            if p == outer {
                break;
            }
        }
        if m == NIL {
            return NIL;
        }
        // Look for points inside the triangle of hole point, segment intersection and endpoint;
        // if there are no points found, we have a valid connection; otherwise choose the point of the minimum angle.
        let stop = m;
        let (mx, my) = (self.nodes[m].x, self.nodes[m].y);
        let mut tan_min = f64::INFINITY;
        p = m;
        loop {
            let pp = &self.nodes[p];
            if hx >= pp.x
                && pp.x >= mx
                && hx != pp.x
                && point_in_triangle(if hy < my { hx } else { qx }, hy, mx, my, if hy < my { qx } else { hx }, hy, pp.x, pp.y)
            {
                let tan = (hy - pp.y).abs() / (hx - pp.x); // tangential
                if self.locally_inside(p, hole)
                    && (tan < tan_min || (tan == tan_min && (pp.x > self.nodes[m].x || (pp.x == self.nodes[m].x && self.sector_contains_sector(m, p)))))
                {
                    m = p;
                    tan_min = tan;
                }
            }
            p = self.nodes[p].next;
            if p == stop {
                break;
            }
        }
        m
    }

    /// Whether sector in vertex m contains sector in vertex p in the same coordinates.
    fn sector_contains_sector(&self, m: usize, p: usize) -> bool {
        self.area(self.nodes[m].prev, m, self.nodes[p].prev) < 0.0 && self.area(self.nodes[p].next, m, self.nodes[m].next) < 0.0
    }

    /// Interlinks polygon nodes in z-order.
    fn index_curve(&mut self, start: usize, min_x: f64, min_y: f64, inv_size: f64) {
        let mut p = start;
        loop {
            if self.nodes[p].z == 0 {
                self.nodes[p].z = z_order(self.nodes[p].x, self.nodes[p].y, min_x, min_y, inv_size);
            }
            self.nodes[p].prev_z = self.nodes[p].prev;
            self.nodes[p].next_z = self.nodes[p].next;
            p = self.nodes[p].next;
            if p == start {
                break;
            }
        }
        let pz = self.nodes[p].prev_z;
        self.nodes[pz].next_z = NIL;
        self.nodes[p].prev_z = NIL;
        self.sort_linked(p);
    }

    /// Simon Tatham's linked list merge sort algorithm.
    fn sort_linked(&mut self, mut list: usize) {
        let mut in_size = 1;
        loop {
            let mut p = list;
            list = NIL;
            let mut tail = NIL;
            let mut num_merges = 0;
            while p != NIL {
                num_merges += 1;
                let mut q = p;
                let mut p_size = 0;
                for _ in 0..in_size {
                    p_size += 1;
                    q = self.nodes[q].next_z;
                    if q == NIL {
                        break;
                    }
                }
                let mut q_size = in_size;
                while p_size > 0 || (q_size > 0 && q != NIL) {
                    let e;
                    if p_size != 0 && (q_size == 0 || q == NIL || self.nodes[p].z <= self.nodes[q].z) {
                        e = p;
                        p = self.nodes[p].next_z;
                        p_size -= 1;
                    } else {
                        e = q;
                        q = self.nodes[q].next_z;
                        q_size -= 1;
                    }
                    if tail != NIL {
                        self.nodes[tail].next_z = e;
                    } else {
                        list = e;
                    }
                    self.nodes[e].prev_z = tail;
                    tail = e;
                }
                p = q;
            }
            self.nodes[tail].next_z = NIL;
            in_size *= 2;
            if num_merges <= 1 {
                break;
            }
        }
    }

    fn get_leftmost(&self, start: usize) -> usize {
        let mut p = start;
        let mut leftmost = start;
        loop {
            let (n, l) = (&self.nodes[p], &self.nodes[leftmost]);
            if n.x < l.x || (n.x == l.x && n.y < l.y) {
                leftmost = p;
            }
            p = n.next;
            if p == start {
                break;
            }
        }
        leftmost
    }

    /// Check if a diagonal between two polygon nodes is valid (lies in polygon interior).
    fn is_valid_diagonal(&self, a: usize, b: usize) -> bool {
        let (na, nb) = (&self.nodes[a], &self.nodes[b]);
        self.nodes[na.next].i != nb.i
            && self.nodes[na.prev].i != nb.i
            && !self.intersects_polygon(a, b)
            && ((self.locally_inside(a, b)
                && self.locally_inside(b, a)
                && self.middle_inside(a, b)
                && (self.area(na.prev, a, nb.prev) != 0.0 || self.area(a, nb.prev, b) != 0.0))
                || (self.equals(a, b) && self.area(na.prev, a, na.next) > 0.0 && self.area(nb.prev, b, nb.next) > 0.0))
    }

    /// Check if two segments intersect.
    fn intersects(&self, p1: usize, q1: usize, p2: usize, q2: usize) -> bool {
        let o1 = sign(self.area(p1, q1, p2));
        let o2 = sign(self.area(p1, q1, q2));
        let o3 = sign(self.area(p2, q2, p1));
        let o4 = sign(self.area(p2, q2, q1));
        if o1 != o2 && o3 != o4 {
            return true;
        }
        (o1 == 0 && self.on_segment(p1, p2, q1))
            || (o2 == 0 && self.on_segment(p1, q2, q1))
            || (o3 == 0 && self.on_segment(p2, p1, q2))
            || (o4 == 0 && self.on_segment(p2, q1, q2))
    }

    /// For collinear points p, q, r, check if point q lies on segment pr.
    fn on_segment(&self, p: usize, q: usize, r: usize) -> bool {
        let (p, q, r) = (&self.nodes[p], &self.nodes[q], &self.nodes[r]);
        q.x <= p.x.max(r.x) && q.x >= p.x.min(r.x) && q.y <= p.y.max(r.y) && q.y >= p.y.min(r.y)
    }

    /// Check if a polygon diagonal intersects any polygon segments.
    fn intersects_polygon(&self, a: usize, b: usize) -> bool {
        let mut p = a;
        loop {
            let pn = self.nodes[p].next;
            let (ai, bi) = (self.nodes[a].i, self.nodes[b].i);
            if self.nodes[p].i != ai && self.nodes[pn].i != ai && self.nodes[p].i != bi && self.nodes[pn].i != bi && self.intersects(p, pn, a, b) {
                return true;
            }
            p = pn;
            if p == a {
                break;
            }
        }
        false
    }

    /// Check if a polygon diagonal is locally inside the polygon.
    fn locally_inside(&self, a: usize, b: usize) -> bool {
        let n = &self.nodes[a];
        if self.area(n.prev, a, n.next) < 0.0 {
            self.area(a, b, n.next) >= 0.0 && self.area(a, n.prev, b) >= 0.0
        } else {
            self.area(a, b, n.prev) < 0.0 || self.area(a, n.next, b) < 0.0
        }
    }

    /// Check if the middle point of a polygon diagonal is inside the polygon.
    fn middle_inside(&self, a: usize, b: usize) -> bool {
        let mut p = a;
        let mut inside = false;
        let px = (self.nodes[a].x + self.nodes[b].x) / 2.0;
        let py = (self.nodes[a].y + self.nodes[b].y) / 2.0;
        loop {
            let (n, nn) = (&self.nodes[p], &self.nodes[self.nodes[p].next]);
            if ((n.y > py) != (nn.y > py)) && nn.y != n.y && (px < (nn.x - n.x) * (py - n.y) / (nn.y - n.y) + n.x) {
                inside = !inside;
            }
            p = n.next;
            if p == a {
                break;
            }
        }
        inside
    }

    /// Links two polygon vertices with a bridge; if the vertices belong to the same ring, it splits
    /// the polygon into two; if one belongs to the outer ring and another to a hole, it merges it into
    /// a single ring.
    fn split_polygon(&mut self, a: usize, b: usize) -> usize {
        let (ai, ax, ay) = (self.nodes[a].i, self.nodes[a].x, self.nodes[a].y);
        let (bi, bx, by) = (self.nodes[b].i, self.nodes[b].x, self.nodes[b].y);
        let a2 = self.create_node(ai, ax, ay);
        let b2 = self.create_node(bi, bx, by);
        let an = self.nodes[a].next;
        let bp = self.nodes[b].prev;
        self.nodes[a].next = b;
        self.nodes[b].prev = a;
        self.nodes[a2].next = an;
        self.nodes[an].prev = a2;
        self.nodes[b2].next = a2;
        self.nodes[a2].prev = b2;
        self.nodes[bp].next = b2;
        self.nodes[b2].prev = bp;
        b2
    }
}

fn signed_area(data: &[f64], start: usize, end: usize, dim: usize) -> f64 {
    let mut sum = 0.0;
    let mut j = end - dim;
    let mut i = start;
    while i < end {
        sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
        j = i;
        i += dim;
    }
    sum
}

/// z-order of a point given coords and size of the data bounding box (a 32-bit signed result, as in JavaScript).
fn z_order(x: f64, y: f64, min_x: f64, min_y: f64, inv_size: f64) -> i32 {
    // Coords are transformed into non-negative 15-bit integer range.
    let mut x = ((x - min_x) * inv_size) as i32 as u32;
    let mut y = ((y - min_y) * inv_size) as i32 as u32;
    x = (x | (x << 8)) & 0x00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;
    y = (y | (y << 8)) & 0x00FF00FF;
    y = (y | (y << 4)) & 0x0F0F0F0F;
    y = (y | (y << 2)) & 0x33333333;
    y = (y | (y << 1)) & 0x55555555;
    (x | (y << 1)) as i32
}

fn sign(num: f64) -> i32 {
    if num > 0.0 {
        1
    } else if num < 0.0 {
        -1
    } else {
        0
    }
}

/// Check if a point lies within a convex triangle.
fn point_in_triangle(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, px: f64, py: f64) -> bool {
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py)
}

/// Check if a point lies within a convex triangle but false if its equal to the first point of the triangle.
fn point_in_triangle_except_first(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, px: f64, py: f64) -> bool {
    !(ax == px && ay == py) && point_in_triangle(ax, ay, bx, by, cx, cy, px, py)
}

// ── ExtrudeGeometry ─────────────────────────────────────────────────────────

/// `ExtrudeGeometry`'s options, with three's defaults.
#[derive(Clone, Copy, Debug)]
pub struct ExtrudeOptions {
    pub curve_segments: usize,
    pub steps: usize,
    pub depth: f64,
    pub bevel_enabled: bool,
    pub bevel_thickness: f64,
    /// `None`: `bevelThickness - 0.1`, three's default.
    pub bevel_size: Option<f64>,
    pub bevel_offset: f64,
    pub bevel_segments: usize,
}

impl Default for ExtrudeOptions {
    fn default() -> Self {
        ExtrudeOptions {
            curve_segments: 12,
            steps: 1,
            depth: 1.0,
            bevel_enabled: true,
            bevel_thickness: 0.2,
            bevel_size: None,
            bevel_offset: 0.0,
            bevel_segments: 3,
        }
    }
}

/// `ExtrudeGeometry`'s `getBevelVec`: where a contour point moves per unit of bevel.
fn get_bevel_vec(in_pt: DVec2, in_prev: DVec2, in_next: DVec2) -> DVec2 {
    let (v_trans_x, v_trans_y, shrink_by);
    let (v_prev_x, v_prev_y) = (in_pt.x - in_prev.x, in_pt.y - in_prev.y);
    let (v_next_x, v_next_y) = (in_next.x - in_pt.x, in_next.y - in_pt.y);
    let v_prev_lensq = v_prev_x * v_prev_x + v_prev_y * v_prev_y;
    let collinear0 = v_prev_x * v_next_y - v_prev_y * v_next_x;
    if collinear0.abs() > f64::EPSILON {
        // Not collinear: length of vectors for normalizing.
        let v_prev_len = v_prev_lensq.sqrt();
        let v_next_len = (v_next_x * v_next_x + v_next_y * v_next_y).sqrt();
        // Shift adjacent points by unit vectors to the left.
        let pt_prev_shift_x = in_prev.x - v_prev_y / v_prev_len;
        let pt_prev_shift_y = in_prev.y + v_prev_x / v_prev_len;
        let pt_next_shift_x = in_next.x - v_next_y / v_next_len;
        let pt_next_shift_y = in_next.y + v_next_x / v_next_len;
        // Scaling factor for v_prev to intersection point.
        let sf =
            ((pt_next_shift_x - pt_prev_shift_x) * v_next_y - (pt_next_shift_y - pt_prev_shift_y) * v_next_x) / (v_prev_x * v_next_y - v_prev_y * v_next_x);
        // Vector from inPt to intersection point.
        let tx = pt_prev_shift_x + v_prev_x * sf - in_pt.x;
        let ty = pt_prev_shift_y + v_prev_y * sf - in_pt.y;
        // Don't normalize!, otherwise sharp corners become ugly but prevent crazy spikes.
        let v_trans_lensq = tx * tx + ty * ty;
        if v_trans_lensq <= 2.0 {
            return DVec2::new(tx, ty);
        }
        v_trans_x = tx;
        v_trans_y = ty;
        shrink_by = (v_trans_lensq / 2.0).sqrt();
    } else {
        // Handle special case of collinear edges.
        let mut direction_eq = false; // assumes: opposite
        if v_prev_x > f64::EPSILON {
            if v_next_x > f64::EPSILON {
                direction_eq = true;
            }
        } else if v_prev_x < -f64::EPSILON {
            if v_next_x < -f64::EPSILON {
                direction_eq = true;
            }
        } else if js_sign(v_prev_y) == js_sign(v_next_y) {
            direction_eq = true;
        }
        if direction_eq {
            v_trans_x = -v_prev_y;
            v_trans_y = v_prev_x;
            shrink_by = v_prev_lensq.sqrt();
        } else {
            v_trans_x = v_prev_x;
            v_trans_y = v_prev_y;
            shrink_by = (v_prev_lensq / 2.0).sqrt();
        }
    }
    DVec2::new(v_trans_x / shrink_by, v_trans_y / shrink_by)
}

/// `Math.sign`.
fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// `ExtrudeGeometry`'s `mergeOverlappingPoints`: drops points (the one *after* a coincident pair, the
/// first for the wrap-around) closer than 1e-10 of their magnitude to the previous point.
fn merge_overlapping_points(points: &mut Vec<DVec2>) {
    const THRESHOLD: f64 = 1e-10;
    const THRESHOLD_SQ: f64 = THRESHOLD * THRESHOLD;
    let mut prev = points[0];
    let mut i = 1;
    while i <= points.len() {
        let current_index = i % points.len();
        let cur = points[current_index];
        let (dx, dy) = (cur.x - prev.x, cur.y - prev.y);
        let dist_sq = dx * dx + dy * dy;
        let scale = cur.x.abs().max(cur.y.abs()).max(prev.x.abs()).max(prev.y.abs());
        let threshold_sq_scaled = THRESHOLD_SQ * scale * scale;
        if dist_sq <= threshold_sq_scaled {
            points.remove(current_index);
            // `i--` then the loop's `i++`.
            continue;
        }
        prev = cur;
        i += 1;
    }
}

/// `new THREE.ExtrudeGeometry(shape, options)` for a shape without holes: non-indexed positions, UVs from
/// `WorldUVGenerator`, and `computeVertexNormals()` (faceted normals), exactly as three builds them.
///
/// three's geometry has no index. The returned [`Mesh`] carries the identity index (`0..n`) so it can be
/// drawn like every other mesh; drop `indices` for a non-indexed draw.
pub fn extrude_geometry(shape: &Shape, o: &ExtrudeOptions) -> Mesh {
    let curve_segments = o.curve_segments;
    let steps = o.steps;
    let depth = o.depth;
    let bevel_enabled = o.bevel_enabled;
    let mut bevel_thickness = o.bevel_thickness;
    let mut bevel_size = o.bevel_size.unwrap_or(bevel_thickness - 0.1);
    let mut bevel_offset = o.bevel_offset;
    let mut bevel_segments = o.bevel_segments;
    if !bevel_enabled {
        bevel_segments = 0;
        bevel_thickness = 0.0;
        bevel_size = 0.0;
        bevel_offset = 0.0;
    }

    let mut vertices = shape.get_points(curve_segments);
    if !is_clockwise(&vertices) {
        vertices.reverse();
    }
    merge_overlapping_points(&mut vertices);
    let mut contour = vertices;
    let vlen = contour.len();

    let scale_pt2 = |pt: DVec2, vec: DVec2, size: f64| DVec2::new(pt.x + vec.x * size, pt.y + vec.y * size);

    let n = contour.len();
    let contour_movements: Vec<DVec2> = (0..n).map(|i| get_bevel_vec(contour[i], contour[(i + n - 1) % n], contour[(i + 1) % n])).collect();

    // The placeholder holds every layer's vertices; the faces below pick from it.
    let mut placeholder: Vec<[f64; 3]> = Vec::new();
    let faces: Vec<[usize; 3]> = if bevel_segments == 0 {
        triangulate_shape(&mut contour, &mut [])
    } else {
        let mut contracted = Vec::new();
        for b in 0..bevel_segments {
            let t = b as f64 / bevel_segments as f64;
            let z = bevel_thickness * (t * PI / 2.0).cos();
            let bs = bevel_size * (t * PI / 2.0).sin() + bevel_offset;
            for i in 0..contour.len() {
                let vert = scale_pt2(contour[i], contour_movements[i], bs);
                placeholder.push([vert.x, vert.y, -z]);
                if t == 0.0 {
                    contracted.push(vert);
                }
            }
        }
        triangulate_shape(&mut contracted, &mut [])
    };
    let bs = bevel_size + bevel_offset;

    // Back facing vertices.
    for i in 0..vlen {
        let vert = if bevel_enabled { scale_pt2(contour[i], contour_movements[i], bs) } else { contour[i] };
        placeholder.push([vert.x, vert.y, 0.0]);
    }
    // Add stepped vertices (including the front-facing ones).
    for s in 1..=steps {
        for i in 0..vlen {
            let vert = if bevel_enabled { scale_pt2(contour[i], contour_movements[i], bs) } else { contour[i] };
            placeholder.push([vert.x, vert.y, depth / steps as f64 * s as f64]);
        }
    }
    // Add the bevel's front half.
    for b in (0..bevel_segments).rev() {
        let t = b as f64 / bevel_segments as f64;
        let z = bevel_thickness * (t * PI / 2.0).cos();
        let bs = bevel_size * (t * PI / 2.0).sin() + bevel_offset;
        for i in 0..contour.len() {
            let vert = scale_pt2(contour[i], contour_movements[i], bs);
            placeholder.push([vert.x, vert.y, depth + z]);
        }
    }

    let mut vertices_array: Vec<[f64; 3]> = Vec::new();
    let mut uv_array: Vec<[f64; 2]> = Vec::new();

    // `f3`: a triangle with `generateTopUV`.
    let f3 = |a: usize, b: usize, c: usize, va: &mut Vec<[f64; 3]>, ua: &mut Vec<[f64; 2]>| {
        va.extend([placeholder[a], placeholder[b], placeholder[c]]);
        let k = va.len();
        for p in [va[k - 3], va[k - 2], va[k - 1]] {
            ua.push([p[0], p[1]]);
        }
    };
    // Lid faces.
    if bevel_enabled {
        let offset = 0;
        for face in &faces {
            f3(face[2] + offset, face[1] + offset, face[0] + offset, &mut vertices_array, &mut uv_array);
        }
        let offset = vlen * (steps + bevel_segments * 2);
        for face in &faces {
            f3(face[0] + offset, face[1] + offset, face[2] + offset, &mut vertices_array, &mut uv_array);
        }
    } else {
        for face in &faces {
            f3(face[2], face[1], face[0], &mut vertices_array, &mut uv_array);
        }
        for face in &faces {
            f3(face[0] + vlen * steps, face[1] + vlen * steps, face[2] + vlen * steps, &mut vertices_array, &mut uv_array);
        }
    }
    // Side walls (`sidewalls` + `f4` with `generateSideWallUV`).
    let sl = steps + bevel_segments * 2;
    for j in (0..contour.len()).rev() {
        let k = if j == 0 { contour.len() - 1 } else { j - 1 };
        for s in 0..sl {
            let (slen1, slen2) = (vlen * s, vlen * (s + 1));
            let (a, b, c, d) = (j + slen1, k + slen1, k + slen2, j + slen2);
            vertices_array.extend([placeholder[a], placeholder[b], placeholder[d], placeholder[b], placeholder[c], placeholder[d]]);
            let m = vertices_array.len();
            let (pa, pb, pc, pd) = (vertices_array[m - 6], vertices_array[m - 3], vertices_array[m - 2], vertices_array[m - 1]);
            let uvs: [[f64; 2]; 4] = if (pa[1] - pb[1]).abs() < (pa[0] - pb[0]).abs() {
                [[pa[0], 1.0 - pa[2]], [pb[0], 1.0 - pb[2]], [pc[0], 1.0 - pc[2]], [pd[0], 1.0 - pd[2]]]
            } else {
                [[pa[1], 1.0 - pa[2]], [pb[1], 1.0 - pb[2]], [pc[1], 1.0 - pc[2]], [pd[1], 1.0 - pd[2]]]
            };
            uv_array.extend([uvs[0], uvs[1], uvs[3], uvs[1], uvs[2], uvs[3]]);
        }
    }

    let mut mesh = Mesh {
        positions: vertices_array.iter().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect(),
        normals: Vec::new(),
        uvs: uv_array.iter().map(|u| [u[0] as f32, u[1] as f32]).collect(),
        indices: Vec::new(),
    };
    compute_vertex_normals(&mut mesh);
    mesh.indices = (0..mesh.positions.len() as u32).collect();
    mesh
}

// ── BufferGeometry helpers ──────────────────────────────────────────────────

/// `BufferGeometry.computeVertexNormals()` for non-indexed geometry (a triangle soup): every vertex
/// of a triangle gets the triangle's normal, from the f32-stored positions, then each is normalised.
pub fn compute_vertex_normals(mesh: &mut Mesh) {
    let p = |i: usize| DVec3::new(mesh.positions[i][0] as f64, mesh.positions[i][1] as f64, mesh.positions[i][2] as f64);
    let mut normals = vec![[0.0f32; 3]; mesh.positions.len()];
    for i in (0..mesh.positions.len()).step_by(3) {
        let (pa, pb, pc) = (p(i), p(i + 1), p(i + 2));
        let cb = pc - pb;
        let ab = pa - pb;
        let n = cb.cross(ab);
        for k in 0..3 {
            normals[i + k] = [n.x as f32, n.y as f32, n.z as f32];
        }
    }
    for n in &mut normals {
        *n = normalize(DVec3::new(n[0] as f64, n[1] as f64, n[2] as f64)).to_array().map(|c| c as f32);
    }
    mesh.normals = normals;
}

/// `Vector3.normalize`: multiplies by `1 / (length || 1)`.
pub fn normalize(v: DVec3) -> DVec3 {
    let len = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
    let s = 1.0 / if len != 0.0 { len } else { 1.0 };
    DVec3::new(v.x * s, v.y * s, v.z * s)
}

/// `BufferGeometry.translate(x, y, z)`: positions moved in f64 and stored back as f32; the normals go
/// through the (identity) normal matrix, which renormalises them.
pub fn translate(mesh: &mut Mesh, x: f64, y: f64, z: f64) {
    for p in &mut mesh.positions {
        *p = [(p[0] as f64 + x) as f32, (p[1] as f64 + y) as f32, (p[2] as f64 + z) as f32];
    }
    for n in &mut mesh.normals {
        *n = normalize(DVec3::new(n[0] as f64, n[1] as f64, n[2] as f64)).to_array().map(|c| c as f32);
    }
}

/// `BufferGeometry.center()`: translates so the bounding box (of the f32 positions) is centred on the origin.
pub fn center(mesh: &mut Mesh) {
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for p in &mesh.positions {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k] as f64);
            hi[k] = hi[k].max(p[k] as f64);
        }
    }
    let c = [-((lo[0] + hi[0]) * 0.5), -((lo[1] + hi[1]) * 0.5), -((lo[2] + hi[2]) * 0.5)];
    translate(mesh, c[0], c[1], c[2]);
}

// ── CatmullRomCurve3 / TubeGeometry ─────────────────────────────────────────

/// `CatmullRomCurve3` with `curveType = "centripetal"` (three's default) and `Curve`'s arc-length machinery
/// (`arcLengthDivisions = 200`).
pub struct CatmullRomCurve3 {
    pub points: Vec<DVec3>,
    pub closed: bool,
    lengths: OnceCell<Vec<f64>>,
}

/// `CubicPoly.initNonuniformCatmullRom` + `calc`.
fn nonuniform_catmull_rom(x0: f64, x1: f64, x2: f64, x3: f64, dt0: f64, dt1: f64, dt2: f64, t: f64) -> f64 {
    // Tangents when parameterized in [t1, t2], rescaled for the parametrization in [0, 1].
    let mut t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
    let mut t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
    t1 *= dt1;
    t2 *= dt1;
    let c0 = x1;
    let c1 = t1;
    let c2 = -3.0 * x1 + 3.0 * x2 - 2.0 * t1 - t2;
    let c3 = 2.0 * x1 - 2.0 * x2 + t1 + t2;
    let t_2 = t * t;
    let t_3 = t_2 * t;
    c0 + c1 * t + c2 * t_2 + c3 * t_3
}

impl CatmullRomCurve3 {
    pub fn new(points: Vec<DVec3>, closed: bool) -> CatmullRomCurve3 {
        CatmullRomCurve3 { points, closed, lengths: OnceCell::new() }
    }

    /// `CatmullRomCurve3.getPoint`. (three's shared scratch vector means that with only two points the
    /// first control point is overwritten by the last extrapolation; reproduced.)
    pub fn get_point(&self, t: f64) -> DVec3 {
        let points = &self.points;
        let l = points.len();
        let p = (l as f64 - if self.closed { 0.0 } else { 1.0 }) * t;
        let mut int_point = p.floor();
        let mut weight = p - int_point;
        if self.closed {
            int_point += if int_point > 0.0 { 0.0 } else { ((int_point.abs() / l as f64).floor() + 1.0) * l as f64 };
        } else if weight == 0.0 && int_point == (l - 1) as f64 {
            int_point = (l - 2) as f64;
            weight = 1.0;
        }
        let ip = int_point as i64;
        let li = l as i64;
        let wrap = |k: i64| points[(k % li) as usize];
        let mut p0 = if self.closed || ip > 0 { wrap(ip - 1) } else { points[0] - points[1] + points[0] };
        let p1 = wrap(ip);
        let p2 = wrap(ip + 1);
        let p3 = if self.closed || ip + 2 < li {
            wrap(ip + 2)
        } else {
            let e = points[l - 1] - points[l - 2] + points[l - 1];
            if !(self.closed || ip > 0) {
                p0 = e;
            }
            e
        };
        let mut dt0 = p0.distance_squared(p1).powf(0.25);
        let mut dt1 = p1.distance_squared(p2).powf(0.25);
        let mut dt2 = p2.distance_squared(p3).powf(0.25);
        // Safety check for repeated points.
        if dt1 < 1e-4 {
            dt1 = 1.0;
        }
        if dt0 < 1e-4 {
            dt0 = dt1;
        }
        if dt2 < 1e-4 {
            dt2 = dt1;
        }
        DVec3::new(
            nonuniform_catmull_rom(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2, weight),
            nonuniform_catmull_rom(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2, weight),
            nonuniform_catmull_rom(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2, weight),
        )
    }

    /// `Curve.getLengths()`: cumulative chord lengths at 200 even steps of `t` (cached).
    fn get_lengths(&self) -> &[f64] {
        self.lengths.get_or_init(|| {
            let divisions = 200;
            let mut cache = vec![0.0];
            let mut last = self.get_point(0.0);
            let mut sum = 0.0;
            for p in 1..=divisions {
                let current = self.get_point(p as f64 / divisions as f64);
                sum += current.distance(last);
                cache.push(sum);
                last = current;
            }
            cache
        })
    }

    /// `Curve.getUtoTmapping(u)`: arc-length fraction → curve parameter.
    pub fn get_u_to_t_mapping(&self, u: f64) -> f64 {
        let arc = self.get_lengths();
        let il = arc.len();
        let target = u * arc[il - 1];
        // Binary search for the index with the largest value smaller than the target.
        let (mut low, mut high) = (0isize, il as isize - 1);
        while low <= high {
            let i = low + (high - low) / 2;
            let comparison = arc[i as usize] - target;
            if comparison < 0.0 {
                low = i + 1;
            } else if comparison > 0.0 {
                high = i - 1;
            } else {
                high = i;
                break;
            }
        }
        let i = high;
        if arc[i as usize] == target {
            return i as f64 / (il - 1) as f64;
        }
        let before = arc[i as usize];
        let after = arc[i as usize + 1];
        let fraction = (target - before) / (after - before);
        (i as f64 + fraction) / (il - 1) as f64
    }

    /// `Curve.getPointAt(u)`.
    pub fn get_point_at(&self, u: f64) -> DVec3 {
        self.get_point(self.get_u_to_t_mapping(u))
    }

    /// `Curve.getTangent(t)`: a central difference of 1e-4 in `t`, normalised.
    fn get_tangent(&self, t: f64) -> DVec3 {
        let delta = 0.0001;
        let mut t1 = t - delta;
        let mut t2 = t + delta;
        if t1 < 0.0 {
            t1 = 0.0;
        }
        if t2 > 1.0 {
            t2 = 1.0;
        }
        normalize(self.get_point(t2) - self.get_point(t1))
    }

    /// `Curve.getTangentAt(u)`.
    pub fn get_tangent_at(&self, u: f64) -> DVec3 {
        self.get_tangent(self.get_u_to_t_mapping(u))
    }

    /// `Curve.computeFrenetFrames(segments, closed)`: (tangents, normals, binormals).
    pub fn compute_frenet_frames(&self, segments: usize, closed: bool) -> (Vec<DVec3>, Vec<DVec3>, Vec<DVec3>) {
        let tangents: Vec<DVec3> = (0..=segments).map(|i| self.get_tangent_at(i as f64 / segments as f64)).collect();
        let mut normals = vec![DVec3::ZERO; segments + 1];
        let mut binormals = vec![DVec3::ZERO; segments + 1];
        // An initial normal perpendicular to the first tangent, in the direction of its smallest component.
        let mut min = f64::MAX;
        let mut normal = DVec3::ZERO;
        let (tx, ty, tz) = (tangents[0].x.abs(), tangents[0].y.abs(), tangents[0].z.abs());
        if tx <= min {
            min = tx;
            normal = DVec3::new(1.0, 0.0, 0.0);
        }
        if ty <= min {
            min = ty;
            normal = DVec3::new(0.0, 1.0, 0.0);
        }
        if tz <= min {
            normal = DVec3::new(0.0, 0.0, 1.0);
        }
        let vec = normalize(tangents[0].cross(normal));
        normals[0] = tangents[0].cross(vec);
        binormals[0] = tangents[0].cross(normals[0]);
        // The slowly-varying normal and binormal of each segment.
        for i in 1..=segments {
            normals[i] = normals[i - 1];
            binormals[i] = binormals[i - 1];
            let mut vec = tangents[i - 1].cross(tangents[i]);
            if (vec.x * vec.x + vec.y * vec.y + vec.z * vec.z).sqrt() > f64::EPSILON {
                vec = normalize(vec);
                let theta = tangents[i - 1].dot(tangents[i]).clamp(-1.0, 1.0).acos();
                normals[i] = apply_rotation_axis(normals[i], vec, theta);
            }
            binormals[i] = tangents[i].cross(normals[i]);
        }
        // A closed curve's last normal is twisted back onto the first.
        if closed {
            let mut theta = normals[0].dot(normals[segments]).clamp(-1.0, 1.0).acos();
            theta /= segments as f64;
            if tangents[0].dot(normals[0].cross(normals[segments])) > 0.0 {
                theta = -theta;
            }
            for i in 1..=segments {
                normals[i] = apply_rotation_axis(normals[i], tangents[i], theta * i as f64);
                binormals[i] = tangents[i].cross(normals[i]);
            }
        }
        (tangents, normals, binormals)
    }
}

/// `v.applyMatrix4(new Matrix4().makeRotationAxis(axis, angle))`.
fn apply_rotation_axis(v: DVec3, axis: DVec3, angle: f64) -> DVec3 {
    let (c, s) = (angle.cos(), angle.sin());
    let t = 1.0 - c;
    let (x, y, z) = (axis.x, axis.y, axis.z);
    let (tx, ty) = (t * x, t * y);
    let (m11, m12, m13) = (tx * x + c, tx * y - s * z, tx * z + s * y);
    let (m21, m22, m23) = (tx * y + s * z, ty * y + c, ty * z - s * x);
    let (m31, m32, m33) = (tx * z - s * y, ty * z + s * x, t * z * z + c);
    DVec3::new(m11 * v.x + m12 * v.y + m13 * v.z, m21 * v.x + m22 * v.y + m23 * v.z, m31 * v.x + m32 * v.y + m33 * v.z)
}

/// `new THREE.TubeGeometry(path, tubularSegments, radius, radialSegments, closed)`: indexed, with the
/// tube's own normals and `(i / tubularSegments, j / radialSegments)` UVs.
pub fn tube_geometry(path: &CatmullRomCurve3, tubular_segments: usize, radius: f64, radial_segments: usize, closed: bool) -> Mesh {
    let (_, frame_normals, frame_binormals) = path.compute_frenet_frames(tubular_segments, closed);
    let mut mesh = Mesh::default();
    let segment = |i: usize, mesh: &mut Mesh| {
        // `getPointAt` samples evenly spaced points.
        let p = path.get_point_at(i as f64 / tubular_segments as f64);
        let (n, b) = (frame_normals[i], frame_binormals[i]);
        for j in 0..=radial_segments {
            let v = j as f64 / radial_segments as f64 * PI * 2.0;
            let sin = v.sin();
            let cos = -v.cos();
            let normal = normalize(DVec3::new(cos * n.x + sin * b.x, cos * n.y + sin * b.y, cos * n.z + sin * b.z));
            mesh.normals.push([normal.x as f32, normal.y as f32, normal.z as f32]);
            mesh.positions.push([(p.x + radius * normal.x) as f32, (p.y + radius * normal.y) as f32, (p.z + radius * normal.z) as f32]);
        }
    };
    for i in 0..tubular_segments {
        segment(i, &mut mesh);
    }
    // The last row of an open tube sits at the end of the path; a closed one repeats the first row.
    segment(if closed { 0 } else { tubular_segments }, &mut mesh);
    for i in 0..=tubular_segments {
        for j in 0..=radial_segments {
            mesh.uvs.push([(i as f64 / tubular_segments as f64) as f32, (j as f64 / radial_segments as f64) as f32]);
        }
    }
    for j in 1..=tubular_segments {
        for i in 1..=radial_segments {
            let a = ((radial_segments + 1) * (j - 1) + (i - 1)) as u32;
            let b = ((radial_segments + 1) * j + (i - 1)) as u32;
            let c = ((radial_segments + 1) * j + i) as u32;
            let d = ((radial_segments + 1) * (j - 1) + i) as u32;
            mesh.indices.extend([a, b, d, b, c, d]);
        }
    }
    mesh
}
