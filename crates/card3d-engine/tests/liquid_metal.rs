//! CPU-side checks of liquid metal (crate::liquid_metal) against the TypeScript
//! (shaders/library/liquid-metal/): the mask's Poisson edge field (paper.ts `toProcessedLiquidMetal`:
//! the boundary scan, `neighbours`, `solvePoissonSparse`, the grey bytes), the live clock (driver.ts
//! `LiquidMetalDriver`) and look.ts's helpers.
//!
//! How the numbers were made: `poisson.mjs` (in the session scratchpad `lm/`) runs paper.ts's own
//! helpers (taken from its source) on the procedural masks below and prints each field's FNV-1a hash,
//! its maximum and a row of grey values; `driver.ts` (same place, run with Node 24's
//! `--experimental-transform-types` from packages/core) steps the driver 50 times (varied `dt`, card
//! normal, pointer, one wheel event) and prints every draw.
#![allow(clippy::excessive_precision, reason = "the expected values are dumped from the TypeScript at full f64 precision")]

use card3d_engine::liquid_metal::{face_height, motion, poisson_field, shader_color_from_hex, stripe_angle, Driver, Look};
use glam::Vec3;

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

type Shape = fn(f64, f64, f64, f64) -> bool;
/// Name, width, height, shape, field hash, grey values of the sampled row.
type Case = (&'static str, usize, usize, Shape, u64, &'static [u8]);

fn blob(x: f64, y: f64, w: f64, h: f64) -> bool {
    let (dx, dy) = (x - w * 0.42, y - h * 0.5);
    let (r, a) = (dx.hypot(dy), dy.atan2(dx));
    (r < h * 0.36 * (1.0 + 0.18 * (5.0 * a + 0.4).cos()) && r > h * 0.11)
        || (w * 0.66 < x && x < w * 0.9 && (y - h * 0.5 - (x - w * 0.66) * 0.35).abs() < h * 0.08)
}

#[test]
fn poisson_field_matches_paper() {
    let cases: [Case; 3] = [
        (
            "blob",
            97,
            64,
            blob,
            0xe9c041775d5ec0a7,
            &[
                255, 255, 255, 255, 255, 255, 213, 113, 49, 22, 28, 57, 85, 93, 81, 58, 50, 93, 204, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
                255, 255, 255,
            ],
        ),
        ("full", 40, 30, |_, _, _, _| true, 0x5272735dbcf4e20d, &[198, 133, 87, 56, 36, 25, 23, 28, 42, 65, 100, 152, 225]),
        // No interior: the maximum is 0, so the shape's grey is 255 · (1 − 0 / 0) = NaN, stored as 0.
        ("line", 20, 10, |_, y, _, _| y == 4.5, 0xdc9b76375f1fcde5, &[0, 0, 0, 0, 0, 0, 0]),
    ];
    for (name, w, h, f, hash, row) in cases {
        let mask: Vec<bool> = (0..w * h).map(|i| f((i % w) as f64 + 0.5, (i / w) as f64 + 0.5, w as f64, h as f64)).collect();
        let field = poisson_field(&mask, w, h);
        let y = if name == "line" { 4 } else { h / 3 };
        let got: Vec<u8> = (0..w).filter(|x| (y * w + x) % 3 == 0).map(|x| field[4 * (y * w + x)]).collect();
        assert_eq!(got, row, "{name}: row {y}");
        assert_eq!(fnv(&field), hash, "{name}: field hash");
    }
}

#[test]
fn look_helpers_match_look_ts() {
    let look = Look::default();
    assert_eq!(shader_color_from_hex("#00000000"), [0.0; 4]);
    assert_eq!(shader_color_from_hex("#606060"), [96.0 / 255.0, 96.0 / 255.0, 96.0 / 255.0, 1.0]);
    assert_eq!(shader_color_from_hex("#f80"), [1.0, 136.0 / 255.0, 0.0, 1.0]);
    assert_eq!(shader_color_from_hex("nope"), [0.5, 0.5, 0.5, 1.0]);
    assert_eq!(motion(&look, 1.0), [0.57 + 0.43 * 0.6, 0.12 + 0.07 * 0.6, 1.1 + 0.08]);
    assert_eq!(stripe_angle(look.angle, None), 166.0);
    assert_eq!(stripe_angle(look.angle, Some(Vec3::Z)), 166.0);
    assert!((stripe_angle(look.angle, Some(Vec3::X)) - 256.0).abs() < 1e-9);
    assert_eq!((face_height(1280), face_height(640), face_height(900)), (807, 404, 568));
}

/// Draws of driver.ts for the steps of `driver_matches_driver_ts`: angle, rotation, distortion, contour,
/// scale, frame clock.
const DRAWS: &[[f64; 6]] = &[
    [166.0, 15.0, 0.6079575062917719, 0.1261791289312187, 1.1117697693927977, 4.254462840918192],
    [168.40304795181837, 15.0, 0.6506675209449304, 0.133131922014291, 1.1250131847891258, 10.487827747349147],
    [170.78597648105472, 15.0, 0.7121135510951084, 0.14313476413176182, 1.144066217393832, 21.123076756092967],
    [175.41474776475457, 15.774918188258368, 0.7678098697874038, 0.1522016067095774, 1.1613363937325285, 39.09278708507062],
    [179.7477202395863, 16.12939416317124, 0.7996683904532985, 0.15738787751565325, 1.1712150047917205, 61.16359947955313],
    [181.76838137096908, 16.35275635285592, 0.8239409076686954, 0.16133921752746205, 1.1787413667189754, 85.34764955784382],
    [185.46783192174644, 16.508653234047415, 0.828, 0.162, 1.1800000000000002, 114.18364955784382],
    [187.13304306012742, 14.965567173621196, 0.828, 0.162, 1.1800000000000002, 133.76364955784382],
    [190.0744170034559, 11.452670033618517, 0.828, 0.162, 1.1800000000000002, 163.8456495578438],
    [192.48700352686285, 10.088599502118996, 0.828, 0.162, 1.1800000000000002, 198.19964955784383],
    [193.4949005709931, 9.778163758223002, 0.828, 0.162, 1.1800000000000002, 223.29764955784384],
    [194.37171961371698, 9.464623656888136, 0.828, 0.162, 1.1800000000000002, 241.27564955784385],
    [195.11874181614374, 7.08807180734874, 0.828, 0.162, 1.1800000000000002, 259.07564955784386],
    [196.22888585992075, 5.429344240896967, 0.828, 0.162, 1.1800000000000002, 281.14764955784386],
    [196.8352841362429, 4.670581470656089, 0.828, 0.162, 1.1800000000000002, 304.6436495578439],
    [196.95176918717507, 4.192470326864623, 0.828, 0.162, 1.1800000000000002, 327.9616495578439],
    [196.81294582857853, 4.126701821272434, 0.828, 0.162, 1.1800000000000002, 355.5516495578439],
    [196.55724408727812, 4.127922525524866, 0.828, 0.162, 1.1800000000000002, 373.8856495578439],
    [195.66979154424618, 4.130701507583694, 0.828, 0.162, 1.1800000000000002, 402.72164955784393],
    [194.27329458288037, 4.131780596262615, 0.828, 0.162, 1.1800000000000002, 435.82964955784394],
    [193.38079645934803, 4.1320261757169305, 0.828, 0.162, 1.1800000000000002, 459.68164955784397],
    [191.20118555241964, 7.388346840333497, 0.828, 0.162, 1.1800000000000002, 494.035649557844],
    [189.91264987308975, 7.653614176249334, 0.828, 0.162, 1.1800000000000002, 514.861649557844],
    [188.49175548218636, 8.652787808198866, 0.828, 0.162, 1.1800000000000002, 535.687649557844],
    [185.25933246046122, 9.231189440261858, 0.828, 0.162, 1.1800000000000002, 557.937649557844],
    [183.45453489086296, 9.595651531342924, 0.828, 0.162, 1.1800000000000002, 580.009649557844],
    [179.49799164037807, 13.696100530009403, 0.828, 0.162, 1.1800000000000002, 606.353649557844],
    [175.14387923621237, 15.571796156214475, 0.828, 0.162, 1.1800000000000002, 634.1216495578441],
    [172.85056734326804, 16.753708364380543, 0.828, 0.162, 1.1800000000000002, 661.7116495578441],
    [168.11509962478308, 17.57863055624898, 0.828, 0.162, 1.1800000000000002, 693.5736495578441],
    [165.7109825765002, 19.044015209975782, 0.828, 0.162, 1.1800000000000002, 716.1796495578441],
    [160.93011218358092, 22.38002198957099, 0.828, 0.162, 1.1800000000000002, 749.2876495578441],
    [158.59280343623536, 22.651780738835498, 0.828, 0.162, 1.1800000000000002, 768.8676495578442],
    [156.3154602146723, 23.67540536106509, 0.828, 0.162, 1.1800000000000002, 788.4476495578442],
];

#[test]
fn driver_matches_driver_ts() {
    let look = Look { rotation: 15.0, ..Look::default() };
    let mut d = Driver::new(look, 1.5, true);
    d.prime();
    let mut draws = Vec::new();
    for i in 0..50 {
        let dt = [0.016, 0.02, 0.033, 0.008, 0.05][i % 5];
        let t = i as f64 * 0.07;
        let n = glam::DVec3::new(0.6 * t.sin(), 0.3 * (1.3 * t).cos(), 1.0).normalize();
        if i % 7 == 3 {
            d.set_pointer([(i as f64).sin(), (2.0 * i as f64).cos() * 0.5]);
        }
        if i == 20 {
            d.wheel(240.0);
        }
        if let Some(s) = d.step(dt, n.as_vec3()) {
            draws.push([s.look.angle, s.look.rotation, s.look.distortion, s.look.contour, s.look.scale, s.frame]);
        }
    }
    assert_eq!(draws.len(), DRAWS.len(), "number of draws");
    for (k, (got, want)) in draws.iter().zip(DRAWS).enumerate() {
        for c in 0..6 {
            assert!((got[c] - want[c]).abs() <= 1e-5 * want[c].abs().max(1.0), "draw {k}, value {c}: {} vs {}", got[c], want[c]);
        }
    }
}
