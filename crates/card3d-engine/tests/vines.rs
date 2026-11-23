//! The vines add-on's CPU side against the TypeScript (the three.js engine's addons/vines/, now in
//! the local archive, .archive/three-engine/packages/core/src/): the vine model (`generateIvy`),
//! `selectVines`, the motion tracker (`IvyMotion`) and `hsvShift`.
//!
//! How the numbers were made: a Node 24 script (kept outside the repository, in the session scratchpad
//! `vines/dump-sums.ts`) ran the TypeScript modules themselves and printed the counts and the weighted
//! sums below (weights `i % k + 1` over the leaf / node index i), the leaf and strand counts that each
//! density keeps, and the tracker's state after a sequence of frames. During the port the full model
//! was also compared value by value: every count, variant, side and phase is identical, and the
//! coordinates agree to 2e-16 (V8's `sin` / `cos` and the `libm` crate's differ in the last bit).

use card3d_engine::vines::{hsv_shift, IvyMotion};
use card3d_engine::vines_model::{generate_ivy, select_vines};
use glam::DQuat;

fn close(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() <= 1e-9 * b.abs().max(1.0), "{what}: {a} vs {b}");
}

#[test]
fn model_matches_typescript() {
    let m = generate_ivy(10729);
    assert_eq!((m.stems.len(), m.leaves.len(), m.stem_leaf_count, m.strands.len()), (131, 717, 696, 115));
    let w = |i: usize, k: usize| (i % k + 1) as f64;
    let mut s = [0.0f64; 9];
    for (i, l) in m.leaves.iter().enumerate() {
        s[0] += l.x * w(i, 7) + l.y * w(i, 5);
        s[1] += l.kz * w(i, 3);
        s[2] += l.angle * w(i, 7);
        s[3] += l.variant * w(i, 5);
        s[4] += l.side * w(i, 3);
        s[5] += l.progress * w(i, 7);
        s[6] += (l.face[0] + 2.0 * l.face[1] + 3.0 * l.face[2]) * w(i, 5);
        s[7] += l.lift * w(i, 7);
        s[8] += (l.width + 2.0 * l.height) * w(i, 3);
    }
    let expected =
        [647.8499379293978, 513.3119628190058, -5049.990782741834, 5399.0, 54.0, 1564.2357419743184, 4881.015230464755, 102.0824790566014, 887.7807479661396];
    let names = ["position", "kz", "angle", "variant", "side", "progress", "face", "lift", "size"];
    for k in 0..9 {
        close(s[k], expected[k], names[k]);
    }
    assert_eq!((s[3], s[4]), (5399.0, 54.0), "variants and sides exactly");
    let (mut nodes, mut pos, mut nrm, mut wid, mut prog) = (0usize, 0.0, 0.0, 0.0, 0.0);
    for n in m.strands.iter().flatten() {
        let i = nodes;
        nodes += 1;
        pos += n.p[0] * w(i, 7) + n.p[1] * w(i, 5) + n.p[2] * w(i, 3);
        nrm += n.n[0] + 2.0 * n.n[1] + 3.0 * n.n[2];
        wid += n.width * w(i, 7);
        prog += n.progress * w(i, 5);
    }
    assert_eq!(nodes, 1820);
    close(pos, 1568.0120316255345, "strand positions");
    close(nrm, -64.9737230380766, "strand normals");
    close(wid, 50.10471009806507, "strand widths");
    close(prog, 2601.0304375685864, "strand progress");
}

#[test]
fn density_keeps_whole_vines() {
    let m = generate_ivy(10729);
    let expected = [(83, 12), (179, 26), (280, 39), (373, 52), (454, 64), (506, 72), (568, 83), (619, 93), (653, 100), (690, 108), (717, 115)];
    for (k, e) in expected.iter().enumerate() {
        let (leaves, strands) = select_vines(&m, (k + 1) as f64 / 11.0);
        assert_eq!((leaves.len(), strands.len()), *e, "{} vines", k + 1);
    }
    assert_eq!(select_vines(&m, 0.0).0.len(), 83, "at least one vine");
}

#[test]
fn motion_matches_typescript() {
    // (time, wind, sway, rustle, velocity, yaw) after each frame, from `new IvyMotion({ time: 75, wind: 599 })`.
    let expected: [[f64; 6]; 10] = [
        [75.01666666666667, 599.0166666666667, 0.0, 0.0, 0.0, 0.0],
        [75.03333333333333, 599.0333333333333, -0.0001286432291666667, 0.12482668095705252, -0.010187187500000002, 0.7483288367392387],
        [75.06633333333333, 599.0663333333333, -0.0008205944798742607, 0.3278900483614797, -0.026892446714680423, 1.0816933416147365],
        [75.06633333333333, 599.0663333333333, -0.0008205944798742607, 0.3278900483614797, 0.0, 0.8991659161636807],
        [75.083, 599.083, -0.0008175783677677645, 0.32032784931853764, 0.000238844280798402, 0.49023568969360326],
        [75.09133333333334, 599.0913333333333, -0.0007709321306601229, 0.3641619555060297, 0.005597548452916994, 0.31572891763443206],
        [75.14133333333334, 599.1413333333333, -0.0013573336241246106, 0.573785012743591, -0.02263006663960525, 0.6590648587108092],
        [75.158, 599.1579999999999, -0.0018255732722019964, 0.6269880149769609, -0.029832378393943378, 1.4117697303390466],
        [75.17466666666667, 599.1746666666666, -0.00214447417983893, 0.6735498630245886, -0.015699788586298988, 0.9860251488953862],
        [75.19466666666666, 599.1946666666665, -0.0022570583511738276, 0.7218175433692343, -0.0008242377642616117, 0.6626697859982333],
    ];
    let dts = [1.0 / 60.0, 1.0 / 60.0, 0.033, 0.3, 1.0 / 60.0, 1.0 / 120.0, 0.05, 1.0 / 60.0, 1.0 / 60.0, 0.02];
    let mut m = IvyMotion::new(75.0, 599.0);
    for (k, (&dt, e)) in dts.iter().zip(&expected).enumerate() {
        let kf = k as f64;
        // three's Euler XYZ → quaternion, and back to the yaw as `Vines::update` reads it.
        let q = DQuat::from_rotation_x(0.1 * kf.sin()) * DQuat::from_rotation_y(0.7 * (0.9 * kf).sin() + 0.2 * kf) * DQuat::from_rotation_z(0.05 * kf);
        let yaw = (q.x * (q.z + q.z) + q.w * (q.y + q.y)).clamp(-1.0, 1.0).asin();
        m.update(dt, yaw, true, [q.x, q.y, q.z, q.w]);
        for (got, (want, what)) in
            [m.time, m.wind, m.sway, m.rustle, m.velocity, yaw].into_iter().zip(e.iter().zip(["time", "wind", "sway", "rustle", "velocity", "yaw"]))
        {
            assert!((got - want).abs() < 1e-12, "frame {k} {what}: {got} vs {want}");
        }
    }
}

#[test]
fn hsv_shift_matches_typescript() {
    let cases = [
        ("#c04080", [-0.3455056179775281, 1.1835205992509363, 1.2151898734177216]),
        ("#123456", [0.32116104868913864, 1.4037104781813432, 0.5443037974683544]),
        ("#6b9e45", [0.0, 1.0, 1.0]),
    ];
    for (target, want) in cases {
        let got = hsv_shift("#6b9e45", target);
        for k in 0..3 {
            assert!((got[k] - want[k]).abs() < 1e-12, "{target}: {got:?} vs {want:?}");
        }
    }
}
