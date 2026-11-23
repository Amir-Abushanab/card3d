//! CPU-side checks of the card shapes and edge groups (`geometry/shape.ts`, `card/edge.ts`) against the
//! TypeScript engine: vertex and index counts, bounds and UV / normal checksums of `buildShapedCardGeometry`.
//! Expected values are what the TypeScript returns (`geom.boundingBox`, and sums of UV / normal
//! components weighted by vertex index, so any change of the attributes' order or values shows).

use card3d_engine::edge::{create_edge_materials, edge_grouped_geometry, CardEdge};
use card3d_engine::geometry::Mesh;
use card3d_engine::material::Resolved;
use card3d_engine::renderer::Material;
use card3d_engine::shape::{geometry_for_shape, resolve_shape, CardShape};
use serde_json::json;

/// The parsers on the engine's JSON reader, fed from `json!` literals.
fn parse_shape(v: &serde_json::Value) -> Option<CardShape> {
    card3d_engine::shape::parse_shape(&card3d_engine::json::parse(&v.to_string()).unwrap())
}
fn parse_edge(v: &serde_json::Value) -> Option<CardEdge> {
    card3d_engine::edge::parse_edge(&card3d_engine::json::parse(&v.to_string()).unwrap())
}

/// (vertices, indices, bounds min xy, bounds max xy, UV u checksum, UV v checksum, normal checksum)
type Summary = (usize, usize, [f64; 2], [f64; 2], f64, f64, f64);

struct Case {
    radius: Option<f64>,
    portrait: bool,
    cutouts: &'static [&'static str],
    /// Body width, height and corner radius of the frame (card units).
    frame: (f64, f64, f64),
    /// Index counts of the caps, bevel and wall groups.
    groups: [usize; 3],
    body: Summary,
    face: Summary,
    back: Summary,
}

fn summary(m: &Mesh) -> Summary {
    let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
    for p in &m.positions {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k] as f64);
            hi[k] = hi[k].max(p[k] as f64);
        }
    }
    let (mut su, mut sv, mut sn) = (0.0, 0.0, 0.0);
    for i in 0..m.uvs.len() {
        su += m.uvs[i][0] as f64 * (i % 7 + 1) as f64;
        sv += m.uvs[i][1] as f64 * (i % 5 + 1) as f64;
        let n = m.normals[i];
        sn += (n[0] as f64 + 2.0 * n[1] as f64 + 3.0 * n[2] as f64) * (i % 3 + 1) as f64;
    }
    (m.positions.len(), m.indices.len(), lo, hi, su, sv, sn)
}

fn check(name: &str, got: Summary, want: Summary) {
    assert_eq!((got.0, got.1), (want.0, want.1), "{name}: vertex / index counts");
    for k in 0..2 {
        assert!((got.2[k] - want.2[k]).abs() < 1e-6 && (got.3[k] - want.3[k]).abs() < 1e-6, "{name}: bounds {got:?} vs {want:?}");
    }
    assert!((got.4 - want.4).abs() < 1e-3, "{name}: u checksum {} vs {}", got.4, want.4);
    assert!((got.5 - want.5).abs() < 1e-3, "{name}: v checksum {} vs {}", got.5, want.5);
    assert!((got.6 - want.6).abs() < 0.05, "{name}: normal checksum {} vs {}", got.6, want.6);
}

#[test]
fn shaped_geometry_matches_the_typescript() {
    let cases = [
        Case {
            radius: Some(0.107),
            portrait: false,
            cutouts: &[],
            frame: (3.37, 2.1251471962616826, 0.11369537500000002),
            groups: [276, 1152, 288],
            body: (
                384,
                1716,
                [-1.684999942779541, -1.0625736713409424],
                [1.684999942779541, 1.0625736713409424],
                753.3383783931495,
                573.3064005402848,
                -7.382647126738448,
            ),
            face: (48, 138, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 90.32384340284625, 72.88931080233306, 288.0),
            back: (48, 138, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 98.676156808011, 72.88931080233306, 288.0),
        },
        Case {
            radius: Some(0.129),
            portrait: false,
            cutouts: &[],
            frame: (3.37, 2.1251471962616826, 0.1370046728971963),
            groups: [300, 1248, 312],
            body: (
                416,
                1860,
                [-1.684999942779541, -1.0625736713409424],
                [1.684999942779541, 1.0625736713409424],
                822.2974598229048,
                621.3555421739002,
                -7.667620054315194,
            ),
            face: (52, 150, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 99.16246535166283, 78.86811851360835, 309.0),
            back: (52, 150, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 102.83753383875592, 78.86811851360835, 309.0),
        },
        Case {
            radius: None,
            portrait: true,
            cutouts: &[],
            frame: (2.1251471962616826, 3.37, 0.1251939252336449),
            groups: [276, 1152, 288],
            body: (
                384,
                1716,
                [-1.0625736713409424, -1.684999942779541],
                [1.0625736713409424, 1.684999942779541],
                753.5094862915576,
                573.1817932597478,
                -7.371353976428509,
            ),
            face: (48, 138, [-1.058655023574829, -1.6810814142227173], [1.058655023574829, 1.6810814142227173], 90.56810930965003, 72.9229919151403, 288.0),
            back: (48, 138, [-1.058655023574829, -1.6810814142227173], [1.058655023574829, 1.6810814142227173], 98.43189133290434, 72.9229919151403, 288.0),
        },
        Case {
            radius: None,
            portrait: false,
            cutouts: &["lanyard"],
            frame: (3.37, 2.1251471962616826, 0.1251939252336449),
            groups: [480, 1920, 480],
            body: (
                640,
                2880,
                [-1.684999942779541, -1.0625736713409424],
                [1.684999942779541, 1.0625736713409424],
                1053.4540323474212,
                795.0148872031714,
                -15.043516271558474,
            ),
            face: (80, 240, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 99.75398824375588, 122.25717553985305, 477.0),
            back: (80, 240, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 214.24601088900818, 122.25717553985305, 477.0),
        },
        Case {
            radius: None,
            portrait: false,
            cutouts: &["notch"],
            frame: (3.37, 2.1251471962616826, 0.1251939252336449),
            groups: [378, 1560, 390],
            body: (
                520,
                2328,
                [-1.684999942779541, -1.0625736713409424],
                [1.684999942779541, 1.0625736713409424],
                1251.9676930193673,
                932.5288035366684,
                277.5152437216602,
            ),
            face: (65, 189, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 155.41349432483548, 116.27746335661504, 387.0),
            back: (65, 189, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 99.58650585112628, 116.27746335661504, 387.0),
        },
        Case {
            radius: None,
            portrait: false,
            cutouts: &["window"],
            frame: (3.37, 2.1251471962616826, 0.1251939252336449),
            groups: [660, 2640, 660],
            body: (
                880,
                3960,
                [-1.684999942779541, -1.0625736713409424],
                [1.684999942779541, 1.0625736713409424],
                1825.0138135281159,
                1378.743904732808,
                -15.119539707011427,
            ),
            face: (110, 330, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 213.51679722603876, 182.19653401267715, 657.0),
            back: (110, 330, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 221.4832039072062, 182.19653401267715, 657.0),
        },
        Case {
            radius: Some(0.124),
            portrait: false,
            cutouts: &["lanyard", "notch", "window"],
            frame: (3.37, 2.1251471962616826, 0.1317591261682243),
            groups: [984, 3888, 972],
            body: (
                1296,
                5844,
                [-1.684999942779541, -1.0625736713409424],
                [1.684999942779541, 1.0625736713409424],
                2653.0488568960864,
                1983.356296451704,
                252.1508013140592,
            ),
            face: (162, 492, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 296.4925660935114, 277.27383331861347, 972.0),
            back: (162, 492, [-1.6810814142227173, -1.058655023574829], [1.6810814142227173, 1.058655023574829], 348.5074355395336, 277.27383331861347, 972.0),
        },
        Case {
            radius: Some(0.11),
            portrait: true,
            cutouts: &["lanyard", "window"],
            frame: (2.1251471962616826, 3.37, 0.11688309579439254),
            groups: [864, 3408, 852],
            body: (
                1136,
                5124,
                [-1.0625736713409424, -1.684999942779541],
                [1.0625736713409424, 1.684999942779541],
                2555.106452895445,
                1919.3241212021094,
                -19.809602698631352,
            ),
            face: (142, 432, [-1.058655023574829, -1.6810814142227173], [1.058655023574829, 1.6810814142227173], 297.2904015305685, 256.0950566222891, 849.0),
            back: (142, 432, [-1.058655023574829, -1.6810814142227173], [1.058655023574829, 1.6810814142227173], 265.70960083132377, 256.0950566222891, 849.0),
        },
    ];
    for (i, c) in cases.iter().enumerate() {
        let mut v = json!({ "cutouts": c.cutouts });
        if let Some(r) = c.radius {
            v["cornerRadius"] = json!(r);
        }
        if c.portrait {
            v["orientation"] = json!("portrait");
        }
        let shape = parse_shape(&v).expect("a non-standard shape");
        let g = geometry_for_shape(&shape).expect("geometry");
        let name = format!("case {i}");
        assert!((g.frame.body_width - c.frame.0).abs() < 1e-9 && (g.frame.body_height - c.frame.1).abs() < 1e-9, "{name}: frame size");
        assert!((g.frame.corner_radius - c.frame.2).abs() < 1e-9, "{name}: corner radius");
        assert_eq!(g.frame.portrait, c.portrait);
        check(&format!("{name} body"), summary(&g.body), c.body);
        check(&format!("{name} face"), summary(&g.face), c.face);
        check(&format!("{name} back face"), summary(&g.back_face), c.back);
        // Edge groups: caps, bevel, walls (index counts per group).
        let groups = edge_grouped_geometry(&g.body);
        let counts: Vec<usize> = groups.iter().map(|m| m.as_ref().map_or(0, |m| m.indices.len())).collect();
        assert_eq!(counts, c.groups, "{name}: edge groups");
    }
}

#[test]
fn cutouts_make_holes_and_faces_stay_in_plane() {
    let plain = geometry_for_shape(&parse_shape(&json!({ "cornerRadius": 0.12 })).unwrap()).unwrap();
    let holed = geometry_for_shape(&parse_shape(&json!({ "cornerRadius": 0.12, "cutouts": ["window"] })).unwrap()).unwrap();
    // The window adds a contour (walls and cap rim) and its cap triangles reach around it.
    assert!(holed.body.positions.len() > plain.body.positions.len() + 400);
    // No face triangle covers the window's centre (between the antenna's top run and embossing area 1).
    let inner_y0 = 13.0 + (4.0 + 0.1) * 0.61 + 0.081;
    let y_mm = (inner_y0 + card3d_engine::iso::ISO_7811_AREAS.number.y0) / 2.0;
    let (cx, cy) = card3d_engine::iso::point(card3d_engine::iso::ID1_WIDTH_MM / 2.0, y_mm, false);
    let covers = |m: &Mesh, x: f64, y: f64| {
        m.indices.as_chunks::<3>().0.iter().any(|t| {
            let [a, b, c] = [t[0], t[1], t[2]].map(|i| m.positions[i as usize].map(f64::from));
            let e = |p: [f64; 3], q: [f64; 3]| (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
            let (d0, d1, d2) = (e(a, b), e(b, c), e(c, a));
            (d0 > 0.0 && d1 > 0.0 && d2 > 0.0) || (d0 < 0.0 && d1 < 0.0 && d2 < 0.0)
        })
    };
    assert!(!covers(&holed.face, cx, cy) && covers(&plain.face, cx, cy));
    assert!(!covers(&holed.back_face, -cx, cy));
    for g in [&holed.face, &holed.back_face] {
        for p in &g.positions {
            assert_eq!(p[2], 0.0);
        }
        for t in g.indices.as_chunks::<3>().0 {
            let [a, b, c] = [t[0], t[1], t[2]].map(|i| g.positions[i as usize]);
            let cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            assert!(cross >= 0.0, "faces wind counter-clockwise");
        }
    }
    // Triangle count of a polygon with holes: points + 2 * holes - 2.
    assert_eq!(holed.face.indices.len() / 3, holed.face.positions.len() + 2 - 2);
}

#[test]
fn the_standard_shape_resolves_to_nothing() {
    assert!(parse_shape(&json!({})).is_none());
    assert!(parse_shape(&json!({ "cornerRadius": 0.118 })).is_none());
    // Out-of-range radii are clamped like `sanitizeShape`.
    let s = parse_shape(&json!({ "cornerRadius": 0.5 })).unwrap();
    assert!((s.corner_radius.unwrap() - 3.48 / 26.99).abs() < 1e-12);
    let s = parse_shape(&json!({ "cutouts": ["window", "bogus", "lanyard", "window"] })).unwrap();
    assert_eq!(s.cutouts, ["lanyard", "window"]);
    assert!(resolve_shape(&s).is_some());
}

#[test]
fn edge_finishes_follow_edge_ts() {
    assert!(parse_edge(&json!({ "color": "#ff0000" })).is_none());
    assert!(parse_edge(&json!({ "finish": "match", "color": "#ff0000" })).unwrap().color.is_none());
    let anodized = parse_edge(&json!({ "finish": "anodized", "color": " #2F6FD6 ", "chamfer": true })).unwrap();
    assert_eq!(anodized.color.as_deref(), Some("#2f6fd6"));
    let r = Resolved {
        color: [0.5, 0.5, 0.5],
        metalness: 1.0,
        roughness: 0.27,
        clearcoat: 0.03,
        clearcoat_roughness: 0.38,
        transmission: 0.0,
        thickness: 0.0,
        ior: 1.5,
    };
    let m = create_edge_materials(&anodized, &r, &Material::default());
    assert_eq!((m.wall.metalness, m.wall.roughness, m.wall.iridescence, m.wall.iridescence_thickness), (0.55, 0.32, 0.45, 560.0));
    assert!(m.wall.emissive.iter().zip(m.wall.color).all(|(e, c)| (e - c * 0.08).abs() < 1e-7));
    // The chamfer: bare metal of the body, lightened by 35 % towards white.
    assert_eq!((m.bevel.roughness, m.bevel.clearcoat), (0.05, 0.6));
    let chamfer_only = create_edge_materials(&parse_edge(&json!({ "chamfer": true })).unwrap(), &r, &Material { roughness: 0.9, ..Default::default() });
    assert_eq!(chamfer_only.wall.roughness, 0.9);
    assert!((chamfer_only.bevel.color[0] - (0.5 + 0.5 * 0.35)).abs() < 1e-6);
}
