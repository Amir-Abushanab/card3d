//! The mark finish maps against `computeFinishFields` (card/finish.ts) on a synthetic mask: a soft
//! ring and a bar, 120 × 60, at 260 px per card unit.

use card3d_engine::finish::{compute_finish_fields, Finish};

fn mask() -> (Vec<u8>, usize, usize) {
    let (w, h) = (120usize, 60usize);
    let mut a = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let r = ((x as f64 - 30.0).powi(2) + (y as f64 - 30.0).powi(2)).sqrt();
            let ring = (4.0 - (r - 18.0).abs()).clamp(0.0, 1.0);
            let bar = if x > 60 && x < 110 && y > 20 && y < 40 { 1.0 } else { 0.0 };
            a[y * w + x] = (255.0 * f64::max(ring, bar) + 0.5).floor() as u8;
        }
    }
    (a, w, h)
}

fn sum(a: Option<&[u8]>) -> u32 {
    a.map_or(0, |a| a.iter().fold(0u32, |s, &v| s.wrapping_mul(31).wrapping_add(v as u32)))
}

#[test]
fn finish_maps_match_the_typescript() {
    let (a, w, h) = mask();
    let expected = [
        (Finish::Embossed, 1.0, [128, 68, 4, 2085724574, 2434599192, 0]),
        (Finish::Embossed, 0.5, [124, 64, 2, 2216799728, 2393267804, 0]),
        (Finish::Engraved, 1.0, [122, 62, 1, 618338459, 1513357382, 1571993177]),
        (Finish::Engraved, 0.5, [122, 62, 1, 1734594670, 3019442270, 1571993177]),
        (Finish::Etched, 1.0, [122, 62, 1, 2662368105, 3437045296, 0]),
        (Finish::Etched, 0.5, [122, 62, 1, 406459564, 3437045296, 0]),
    ];
    for (f, rs, e) in expected {
        let r = compute_finish_fields(&a, w, h, f, 260.0, rs);
        let got = [r.width, r.height, r.pad, sum(Some(&r.color)), sum(Some(&r.normal)), sum(r.roughness.as_deref())];
        assert_eq!(got, e, "{f:?} relief scale {rs}");
    }
}
