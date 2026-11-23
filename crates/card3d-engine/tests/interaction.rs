//! The interaction state machine (`scene/interaction.ts`) against the TypeScript's own numbers.
//!
//! The expected values were recorded by running the real `CardInteraction` (`orientCard`,
//! `flipTarget`, `flipDuration`, `fitToViewportScale`) under node 24 (type stripping, three
//! 0.180.0) with a fake element (an `EventTarget` with `getBoundingClientRect` / `clientWidth`), a
//! `THREE.Object3D` target, a mocked `performance.now` and a manual `requestAnimationFrame` queue,
//! scripting each scenario below and recording the target's quaternion, position, scale, the
//! rotation / flip state, whether a frame was still queued, the return value of the DOM handler
//! (taken / `preventDefault`) and the `onRotationChange` / `onFlippedChange` calls after every step.
//! The recording script lives outside the repo; each `Op` here is one of its steps. Times are the
//! mocked clock in ms (scenarios start at 1000). Quaternions are compared at 1e-5 (the f32 the GPU
//! gets) and again at 1e-9 in f64; everything else at 1e-9.
//!
//! Where the TypeScript's `requestAnimationFrame` callbacks run in registration order, the Rust
//! `update` runs intro, interrupt, flip, drag flush; no scenario depends on a different order.

#![allow(clippy::approx_constant, reason = "recorded values can land on a named constant (a quarter turn about +Y is sqrt(1/2))")]

use card3d_engine::interaction::*;

#[derive(Clone, Copy, Debug)]
enum Op {
    Start(f64),
    Update(f64),
    Down(i32, f64, f64, f64, f64, f64),
    Move(i32, f64, f64, f64),
    Up(i32, f64, f64, f64),
    Cancel(i32),
    Key(&'static str, f64),
    SetFlipped(bool, f64),
    Toggle(f64),
    Reset,
    DblClick,
    SetRotation(f64, f64),
    SetActive(bool, f64),
    StartIntro(f64),
    Interrupt(f64),
    Aspect(f64, f64),
    Visible(bool),
    Reduced(bool),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Ev {
    Rot(f64, f64),
    Flip(bool),
}

struct E {
    q: [f64; 4],
    pos: [f64; 3],
    scale: f64,
    rot: [f64; 2],
    flip: f64,
    flipped: bool,
    intro: Option<&'static str>,
    anim: bool,
    ret: Option<bool>,
    ev: &'static [Ev],
}

fn e(
    q: [f64; 4],
    pos: [f64; 3],
    scale: f64,
    rot: [f64; 2],
    flip: f64,
    flipped: bool,
    intro: Option<&'static str>,
    anim: bool,
    ret: Option<bool>,
    ev: &'static [Ev],
) -> E {
    E { q, pos, scale, rot, flip, flipped, intro, anim, ret, ev }
}

fn near(a: f64, b: f64, tol: f64, what: &str, step: usize, op: Op) {
    assert!((a - b).abs() <= tol || (a.is_nan() && b.is_nan()), "step {step} {op:?}: {what}: got {a}, expected {b}");
}

fn run(opts: InteractionOptions, steps: &[(Op, E)]) {
    // The recording's fake element is 800 x 600.
    let mut c = CardInteraction::new(InteractionOptions { aspect: 800.0 / 600.0, ..opts });
    for (i, (op, want)) in steps.iter().enumerate() {
        let mut ret = None;
        let mut frame = None;
        match *op {
            Op::Start(t) => c.start_intro(t),
            Op::Update(t) => frame = Some(c.update(t)),
            Op::Down(id, x, y, w, h, t) => ret = Some(c.pointer_down(id, x, y, w, h, t)),
            Op::Move(id, x, y, t) => ret = Some(c.pointer_move(id, x, y, t)),
            Op::Up(id, x, y, t) => c.pointer_up(id, x, y, t),
            Op::Cancel(id) => c.pointer_cancel(id),
            Op::Key(k, t) => ret = Some(c.key(k, t)),
            Op::SetFlipped(b, t) => c.set_flipped(b, t),
            Op::Toggle(t) => c.toggle_flip(t),
            Op::Reset => c.reset(),
            Op::DblClick => c.double_click(),
            Op::SetRotation(x, y) => c.set_rotation(CardRotation { x, y }),
            Op::SetActive(b, t) => c.set_active(b, t),
            Op::StartIntro(t) => c.start_intro(t),
            Op::Interrupt(t) => c.interrupt_intro(t),
            Op::Aspect(w, h) => c.set_aspect(w / h),
            Op::Visible(b) => c.set_visible(b),
            Op::Reduced(b) => c.set_reduced_motion(b),
        }
        let f = frame.unwrap_or_else(|| c.snapshot());
        let q = f.quaternion.to_array().map(f64::from);
        let qd = f.quaternion_f64.to_array();
        for k in 0..4 {
            near(q[k], want.q[k], 1e-5, "quaternion (f32)", i, *op);
            near(qd[k], want.q[k], 1e-9, "quaternion (f64)", i, *op);
        }
        for k in 0..3 {
            near(f.position[k], want.pos[k], 1e-9, "position", i, *op);
        }
        near(f.scale, want.scale, 1e-9, "scale", i, *op);
        near(f.rotation.x, want.rot[0], 1e-9, "pitch", i, *op);
        near(f.rotation.y, want.rot[1], 1e-9, "yaw", i, *op);
        near(f.flip_deg, want.flip, 1e-9, "flip_deg", i, *op);
        assert_eq!(f.flipped, want.flipped, "step {i} {op:?}: flipped");
        assert_eq!(f.intro_state.map(IntroState::as_str), want.intro, "step {i} {op:?}: intro state");
        assert_eq!(f.animating, want.anim, "step {i} {op:?}: animating");
        assert_eq!(ret, want.ret, "step {i} {op:?}: handled");
        let got: Vec<Ev> = c
            .drain_events()
            .into_iter()
            .map(|e| match e {
                InteractionEvent::RotationChange(r) => Ev::Rot(r.x, r.y),
                InteractionEvent::FlippedChange(b) => Ev::Flip(b),
            })
            .collect();
        assert_eq!(got.len(), want.ev.len(), "step {i} {op:?}: events {got:?} vs {:?}", want.ev);
        for (g, w) in got.iter().zip(want.ev) {
            match (g, w) {
                (Ev::Rot(a, b), Ev::Rot(c, d)) => {
                    near(*a, *c, 1e-9, "event pitch", i, *op);
                    near(*b, *d, 1e-9, "event yaw", i, *op);
                }
                _ => assert_eq!(g, w, "step {i} {op:?}: event"),
            }
        }
    }
}

#[test]
fn flip_target_matches_the_typescript() {
    let cases: &[(f64, bool, f64)] = &[
        (0.0, true, 180.0),
        (0.0, false, 0.0),
        (180.0, true, 180.0),
        (180.0, false, 360.0),
        (100.0, false, 0.0),
        (100.0, true, 180.0),
        (-100.0, true, -180.0),
        (540.0, false, 720.0),
        (360.0, true, 540.0),
        (90.0, true, 180.0),
        (270.0, true, 180.0),
        (-90.0, false, 0.0),
        (180.5, false, 360.0),
        (-180.0, false, 0.0),
        (179.99, false, 0.0),
        (720.0, true, 900.0),
    ];
    for &(from, flipped, want) in cases {
        assert_eq!(flip_target(from, flipped), want, "flip_target({from}, {flipped})");
    }
}

#[test]
fn flip_duration_matches_the_typescript() {
    let cases: &[(f64, f64)] = &[
        (0.0, 220.0),
        (5.0, 220.0),
        (20.0, 220.0),
        (45.0, 310.0),
        (90.0, 438.4062043356595),
        (100.0, 462.1207153499565),
        (135.0, 536.9357503463519),
        (180.0, 620.0),
        (270.0, 620.0),
        (360.0, 620.0),
    ];
    for &(delta, want) in cases {
        near(flip_duration(delta), want, 1e-9, "flip_duration", 0, Op::Reduced(false));
    }
}

#[test]
fn orient_card_matches_the_typescript() {
    let cases: &[([f64; 4], [f64; 4])] = &[
        ([0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
        ([20.0, 30.0, 0.0, 0.0], [0.16773125949652062, 0.25488700224417876, 0.044943455527547777, 0.9512512425641977]),
        ([-10.0, -34.0, 90.0, -14.0], [0.030814426605461284, 0.45921248275176907, -0.09760862640967041, 0.8824097250418028]),
        ([68.0, 90.0, 180.0, 0.0], [-0.39540909403555957, 0.5862180894121044, 0.3954090940355596, -0.5862180894121043]),
        ([-30.0, 200.0, 360.0, 5.0], [-0.08639367574770482, -0.9483854561651013, 0.26196074107763223, 0.15645360161840577]),
        ([12.5, -77.0, 540.0, -7.0], [-0.11513793021809647, -0.7723682185989788, -0.12281891770639618, -0.6124590642457359]),
    ];
    for &([x, y, flip, roll], want) in cases {
        let q = orient_card(CardRotation { x, y }, flip, roll).to_array();
        for k in 0..4 {
            near(q[k], want[k], 1e-9, "orient_card", k, Op::Reduced(false));
        }
    }
}

#[test]
fn fit_to_viewport_scale_matches_the_typescript() {
    let cases: &[([f64; 2], f64, f64)] = &[
        ([0.0, 0.0], 1.0, 0.8609919683472859),
        ([25.0, 40.0], 1.0, 0.8533392590061852),
        ([25.0, 80.0], 0.5, 0.7491530048504238),
        ([35.0, 50.0], 0.7, 0.7038930467392128),
        ([0.0, 0.0], 1.6, 1.0),
        ([68.0, 90.0], 1.6, 0.7154042396112603),
        ([0.0, 90.0], 1.0, 0.9645856037298108),
        ([10.0, 10.0], 0.0, 1.0),
        ([10.0, 10.0], f64::NAN, 1.0),
        ([45.0, 45.0], 0.3, 0.68),
    ];
    for &([x, y], aspect, want) in cases {
        let q = orient_card(CardRotation { x, y }, 0.0, 0.0);
        near(fit_to_viewport_scale(q, aspect), want, 1e-9, "fit scale", 0, Op::Reduced(false));
    }
}

#[test]
fn intro_through_its_3600_ms() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1016.0),
                e(
                    [-0.047230596014362684, -0.29924538903139647, -0.09080886501083299, 0.948670236688714],
                    [0.0, -0.21999980814403008, 0.0],
                    1.0,
                    [-9.999991279274095, -33.99997034953192],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1100.0),
                e(
                    [-0.047222239489602566, -0.2991865449757983, -0.09082138543028069, 0.9486880137071173],
                    [0.0, -0.2199547892692933, 0.0],
                    1.0,
                    [-9.99794496678606, -33.9930128870726],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1500.0),
                e(
                    [-0.046347488363492874, -0.29304931931050415, -0.09211233368612215, 0.9505205546209626],
                    [0.0, -0.21526553490004063, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2000.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.19031067418584566, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2080.0),
                e(
                    [-0.04033209858357929, -0.2519127873726227, -0.10001575179543126, 0.9617224749244424],
                    [0.0, -0.1841224, 0.0],
                    1.0,
                    [-8.3692, -28.45528],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2500.0),
                e(
                    [-0.03292010879851273, -0.19757719355939818, -0.10427193768961843, 0.9741698424978771],
                    [0.0, -0.14374373070987656, 0.0],
                    1.0,
                    [-6.5338059413580245, -22.214940200617285],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2800.0),
                e(
                    [-0.027502463321899283, -0.15136297660286455, -0.09664828481135213, 0.9833575000314849],
                    [0.0, -0.11, 0.0],
                    1.0,
                    [-5.0, -17.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(3500.0),
                e(
                    [-0.012483450730131213, -0.051201920654957794, -0.045864256830675874, 0.9975565130479984],
                    [0.0, -0.037511611781105514, 0.0],
                    1.0,
                    [-1.705073262777523, -5.797249093443579],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4000.0),
                e(
                    [-0.002979509040323958, -0.010564899365680254, -0.01112825427253171, 0.9998778262288436],
                    [0.0, -0.007808641975308672, 0.0],
                    1.0,
                    [-0.35493827160494007, -1.2067901234567984],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4500.0),
                e(
                    [-0.000017929165522945333, -0.000060975351604962354, -0.00007187056584698785, 0.9999999953975868],
                    [0.0, -0.00004521073070692938, 0.0],
                    1.0,
                    [-0.002055033213951063, -0.006987112927433259],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4599.0),
                e(
                    [-1.869643229842642e-11, -6.356787603322187e-11, -7.629837902540962e-11, 1.0],
                    [0.0, -4.7133991154524324e-11, 0.0],
                    1.0,
                    [-2.1424533258596057e-9, -7.284342018465395e-9],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (Op::Update(4600.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("complete"), false, None, &[])),
            (Op::Update(4700.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("complete"), false, None, &[])),
        ],
    );
}

#[test]
fn intro_with_default_rotation_yaw_direction_and_back_face() {
    run(
        InteractionOptions {
            default_rotation: CardRotation { x: 8.0, y: -20.0 },
            rotation: Some(CardRotation { x: 3.0, y: 4.0 }),
            default_flipped: true,
            yaw_direction: 1.0,
            ..Default::default()
        },
        &[
            (
                Op::Start(1000.0),
                e(
                    [0.14139268177897824, 0.9424592426384609, -0.11822175244653604, -0.27893064147410723],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, 34.0],
                    180.0,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [0.14139268177897824, 0.9424592426384609, -0.11822175244653604, -0.27893064147410723],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, 34.0],
                    180.0,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1400.0),
                e(
                    [0.1406377250543964, 0.9442833473819358, -0.11601604878972155, -0.2740260326536716],
                    [0.0, -0.21746278514454098, 0.0],
                    1.0,
                    [-9.792409693644261, 33.377229080932786],
                    180.0,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2800.0),
                e(
                    [0.10463567415119014, 0.9925970313890661, -0.015030133803184801, -0.05980471595449176],
                    [0.0, -0.11, 0.0],
                    1.0,
                    [-1.0, 7.0],
                    180.0,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4600.0),
                e(
                    [0.012113084546138434, 0.9824088108221348, 0.06869671616600713, 0.17322517943366061],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [8.0, -20.0],
                    180.0,
                    true,
                    Some("complete"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn intro_interrupted_by_a_drag() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1900.0),
                e(
                    [-0.04290528800354176, -0.2692989071478158, -0.09683305468525422, 0.9572150199357758],
                    [0.0, -0.1972265625, 0.0],
                    1.0,
                    [-8.96484375, -30.48046875],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2000.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.19031067418584566, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(1, 200.0, 125.0, 400.0, 250.0, 2000.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.19031067418584566, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(2100.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.021814457211678417, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Move(1, 230.0, 140.0, 2110.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.021814457211678417, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(2120.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, -0.014144925487673278, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    None,
                    &[Ev::Rot(-15.850485190265712, -45.91164964690342)],
                ),
            ),
            (
                Op::Update(2250.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, -0.0008465766907645404, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2320.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2330.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2400.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2600.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Up(1, 230.0, 140.0, 2700.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2800.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(5000.0),
                e(
                    [-0.12696155362906408, -0.386296134964434, 0.053776494982378624, 0.9120110463141575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-15.850485190265712, -45.91164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn intro_interrupted_by_a_click_then_flip() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1600.0),
                e(
                    [-0.045769428828650774, -0.28901747257337623, -0.09294442668712076, 0.9517013152664018],
                    [0.0, -0.21219135802469136, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(4, 10.0, 10.0, 400.0, 250.0, 1700.0),
                e(
                    [-0.045769428828650774, -0.28901747257337623, -0.09294442668712076, 0.9517013152664018],
                    [0.0, -0.21219135802469136, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Up(4, 10.0, 10.0, 1750.0),
                e(
                    [-0.045769428828650774, -0.28901747257337623, -0.09294442668712076, 0.9517013152664018],
                    [0.0, -0.21219135802469136, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    0.0,
                    true,
                    Some("interrupting"),
                    true,
                    None,
                    &[Ev::Flip(true)],
                ),
            ),
            (
                Op::Update(1760.0),
                e(
                    [-0.08346488158174603, -0.11931181393695989, 0.010066143250437127, 0.9892911489332546],
                    [0.0, -0.05784907918266704, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    19.03951202802185,
                    true,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1800.0),
                e(
                    [-0.07786943472432033, 0.3755789298503318, -0.03168698207636729, 0.9229695302419719],
                    [0.0, -0.024322541655216495, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    77.0784354255648,
                    true,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1900.0),
                e(
                    [-0.04605947602192087, 0.8336003011526366, -0.0703294985477595, 0.5459329851005892],
                    [0.0, -0.0027879836298559516, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    146.35084764716532,
                    true,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2020.0),
                e(
                    [-0.029847031309842308, 0.9315464539494327, -0.07859305579618661, 0.35377039225583035],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    171.2029830814749,
                    true,
                    Some("interrupted"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2100.0),
                e(
                    [-0.026250900371669144, 0.946636312824755, -0.07986616259136224, 0.3111462317691783],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    176.40325518376918,
                    true,
                    Some("interrupted"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2400.0),
                e(
                    [-0.023731581384520944, 0.955934554233179, -0.0806506400618313, 0.2812852899204297],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.645061728395062, -32.79320987654321],
                    180.0,
                    true,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn drag_with_pitch_clamping() {
    run(
        InteractionOptions { default_rotation: CardRotation { x: 5.0, y: -10.0 }, play_intro: false, ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [0.0434534024273578, -0.0870727897926938, -0.0038016801040236755, 0.9952465414778341],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, -10.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(7, 100.0, 100.0, 400.0, 250.0, 1000.0),
                e(
                    [0.0434534024273578, -0.0870727897926938, -0.0038016801040236755, 0.9952465414778341],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, -10.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Move(7, 103.0, 102.0, 1010.0),
                e(
                    [0.0434534024273578, -0.0870727897926938, -0.0038016801040236755, 0.9952465414778341],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, -10.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(1016.0),
                e(
                    [0.0434534024273578, -0.0870727897926938, -0.0038016801040236755, 0.9952465414778341],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, -10.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Move(7, 120.0, 90.0, 1020.0),
                e(
                    [0.0434534024273578, -0.0870727897926938, -0.0038016801040236755, 0.9952465414778341],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, -10.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(1032.0),
                e(
                    [0.08398660886382966, -0.18156950862297913, -0.01556599787386053, 0.9796614021079707],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [9.8, -21.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(9.8, -21.0)],
                ),
            ),
            (
                Op::Move(7, 220.0, 90.0, 1040.0),
                e(
                    [0.08398660886382966, -0.18156950862297913, -0.01556599787386053, 0.9796614021079707],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [9.8, -21.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Move(7, 160.0, -300.0, 1045.0),
                e(
                    [0.08398660886382966, -0.18156950862297913, -0.01556599787386053, 0.9796614021079707],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [9.8, -21.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(1048.0),
                e(
                    [0.5202829012800594, -0.30384328734195637, -0.2049448850975503, 0.7713511220223831],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [68.0, -43.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(68.0, -43.0)],
                ),
            ),
            (
                Op::Move(7, 160.0, 600.0, 1060.0),
                e(
                    [0.5202829012800594, -0.30384328734195637, -0.2049448850975503, 0.7713511220223831],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [68.0, -43.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(1064.0),
                e(
                    [-0.5202829012800594, -0.30384328734195637, 0.2049448850975503, 0.7713511220223831],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-68.0, -43.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(-68.0, -43.0)],
                ),
            ),
            (
                Op::Move(7, -400.0, 100.0, 1070.0),
                e(
                    [-0.5202829012800594, -0.30384328734195637, 0.2049448850975503, 0.7713511220223831],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-68.0, -43.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Up(7, -400.0, 100.0, 1080.0),
                e(
                    [-0.029468830966215255, 0.7365756121527629, 0.0321595857500041, -0.6749471954365435],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, 265.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(5.0, 265.0)],
                ),
            ),
            (
                Op::Update(1090.0),
                e(
                    [-0.029468830966215255, 0.7365756121527629, 0.0321595857500041, -0.6749471954365435],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, 265.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(7, 50.0, 50.0, 400.0, 250.0, 1200.0),
                e(
                    [-0.029468830966215255, 0.7365756121527629, 0.0321595857500041, -0.6749471954365435],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, 265.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Move(7, 90.0, 70.0, 1210.0),
                e(
                    [-0.029468830966215255, 0.7365756121527629, 0.0321595857500041, -0.6749471954365435],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [5.0, 265.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(1220.0),
                e(
                    [0.020968803997740693, 0.851953273272069, -0.03421797818078606, -0.5220776373195186],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-4.6, 243.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(-4.6, 243.0)],
                ),
            ),
            (
                Op::Move(7, 100.0, 80.0, 1230.0),
                e(
                    [0.020968803997740693, 0.851953273272069, -0.03421797818078606, -0.5220776373195186],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-4.6, 243.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Cancel(7),
                e(
                    [0.020968803997740693, 0.851953273272069, -0.03421797818078606, -0.5220776373195186],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-4.6, 243.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1240.0),
                e(
                    [0.039411502393053986, 0.8737786627617857, -0.0718376828387274, -0.4793713897446428],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.399999999999999, 237.5],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(-9.399999999999999, 237.5)],
                ),
            ),
            (
                Op::Update(1250.0),
                e(
                    [0.039411502393053986, 0.8737786627617857, -0.0718376828387274, -0.4793713897446428],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.399999999999999, 237.5],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Move(7, 300.0, 300.0, 1260.0),
                e(
                    [0.039411502393053986, 0.8737786627617857, -0.0718376828387274, -0.4793713897446428],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.399999999999999, 237.5],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    Some(false),
                    &[],
                ),
            ),
            (
                Op::Update(1270.0),
                e(
                    [0.039411502393053986, 0.8737786627617857, -0.0718376828387274, -0.4793713897446428],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.399999999999999, 237.5],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn drag_width_zero_and_second_pointer_ignored() {
    run(
        InteractionOptions { play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::Down(1, 0.0, 0.0, 0.0, 0.0, 1000.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(true), &[]),
            ),
            (
                Op::Down(2, 0.0, 0.0, 400.0, 250.0, 1001.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(true), &[]),
            ),
            (Op::Move(2, 40.0, 40.0, 1002.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), true, Some(true), &[])),
            (Op::Move(1, 0.5, 0.25, 1003.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), true, Some(false), &[])),
            (Op::Move(1, 5.0, 0.0, 1004.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), true, Some(false), &[])),
            (
                Op::Update(1016.0),
                e(
                    [-0.16370473512602432, -0.1881369132786775, 0.031820977021104924, 0.9678805127600782],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-19.2, -22.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(-19.2, -22.0)],
                ),
            ),
            (
                Op::Up(2, 40.0, 40.0, 1020.0),
                e(
                    [-0.16370473512602432, -0.1881369132786775, 0.031820977021104924, 0.9678805127600782],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-19.2, -22.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Up(1, 5.0, 0.0, 1030.0),
                e(
                    [-0.16370473512602432, -0.1881369132786775, 0.031820977021104924, 0.9678805127600782],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-19.2, -22.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1040.0),
                e(
                    [-0.16370473512602432, -0.1881369132786775, 0.031820977021104924, 0.9678805127600782],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-19.2, -22.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn click_flips_and_runs_620_ms() {
    run(
        InteractionOptions { play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::Down(1, 20.0, 20.0, 400.0, 250.0, 1000.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(true), &[]),
            ),
            (
                Op::Up(1, 20.0, 20.0, 1100.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, true, Some("skipped"), true, None, &[Ev::Flip(true)]),
            ),
            (Op::Update(1100.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, true, Some("skipped"), true, None, &[])),
            (
                Op::Update(1116.0),
                e(
                    [0.0, 0.2544532419809825, 0.0, 0.9670850777699797],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    29.482379189489286,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1200.0),
                e(
                    [0.0, 0.8710031405288352, 0.0, 0.4912774462448954],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    121.15084191972426,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1400.0),
                e(
                    [0.0, 0.9984937148543173, 0.0, 0.05486621361480505],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    173.70963636630955,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1600.0),
                e(
                    [0.0, 0.9999827858334042, 0.0, 0.005867540955475078],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    179.32762547613547,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1719.0),
                e(
                    [0.0, 0.9999987968482612, 0.0, 0.0015512259764729876],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    179.82224252566434,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (Op::Update(1720.0), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("skipped"), false, None, &[])),
            (Op::Update(1900.0), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("skipped"), false, None, &[])),
            (
                Op::Down(1, 20.0, 20.0, 400.0, 250.0, 3000.0),
                e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("skipped"), false, Some(true), &[]),
            ),
            (
                Op::Move(1, 22.0, 21.0, 3100.0),
                e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("skipped"), false, Some(true), &[]),
            ),
            (
                Op::Up(1, 22.0, 21.0, 3800.0),
                e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, false, Some("skipped"), true, None, &[Ev::Flip(false)]),
            ),
            (
                Op::Update(3850.0),
                e(
                    [0.0, 0.7821818758495049, 0.0, -0.623050169001301],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    257.0784354255648,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4200.0),
                e(
                    [0.0, 0.01794599566892744, 0.0, -0.9998389576524066],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    357.94342997854744,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4419.0),
                e(
                    [0.0, 0.0015512259764726046, 0.0, -0.9999987968482612],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    359.82224252566436,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4420.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[]),
            ),
            (
                Op::Update(4600.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[]),
            ),
        ],
    );
}

#[test]
fn slow_press_does_not_flip() {
    run(
        InteractionOptions { play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::Down(1, 20.0, 20.0, 400.0, 250.0, 1000.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(true), &[]),
            ),
            (Op::Up(1, 20.0, 20.0, 1801.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (Op::Update(1900.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::Down(1, 20.0, 20.0, 400.0, 250.0, 2000.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(true), &[]),
            ),
            (
                Op::Up(1, 20.0, 20.0, 2800.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, true, Some("skipped"), true, None, &[Ev::Flip(true)]),
            ),
            (
                Op::Update(2900.0),
                e(
                    [0.0, 0.8710031405288352, 0.0, 0.4912774462448954],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    121.15084191972426,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn flip_and_reverse_mid_flip() {
    run(
        InteractionOptions { play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::SetFlipped(true, 1000.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, true, Some("skipped"), true, None, &[Ev::Flip(true)]),
            ),
            (Op::Update(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, true, Some("skipped"), true, None, &[])),
            (
                Op::Update(1050.0),
                e(
                    [0.0, 0.6230501690013008, 0.0, 0.7821818758495049],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    77.0784354255648,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1200.0),
                e(
                    [0.0, 0.9859375740880129, 0.0, 0.1671140329279506],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    160.75986996245953,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1310.0),
                e([0.0, 0.9987954562051724, 0.0, 0.049067674327418126], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 174.375, true, Some("skipped"), true, None, &[]),
            ),
            (
                Op::SetFlipped(false, 1310.0),
                e(
                    [0.0, 0.9987954562051724, 0.0, 0.049067674327418126],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    174.375,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[Ev::Flip(false)],
                ),
            ),
            (
                Op::Update(1320.0),
                e(
                    [0.0, 0.9775112869347073, 0.0, 0.21088310485966452],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    155.6517810874878,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1400.0),
                e(
                    [0.0, 0.5205288137499027, 0.0, 0.8538441040705962],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    62.73545993007434,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1500.0),
                e(
                    [0.0, 0.174911936316631, 0.0, 0.9845840820031405],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    20.147066776097887,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1600.0),
                e(
                    [0.0, 0.05643222307088495, 0.0, 0.9984064323707444],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    6.470093630188927,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1700.0),
                e(
                    [0.0, 0.018131464267991386, 0.0, 0.9998356114899581],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    2.0778266160846783,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1900.0),
                e(
                    [0.0, 0.0018700529477867513, 0.0, 0.9999982514494575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    0.2142924076487418,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Toggle(2000.0),
                e(
                    [0.0, 0.0018700529477867513, 0.0, 0.9999982514494575],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    0.2142924076487418,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[Ev::Flip(true)],
                ),
            ),
            (
                Op::Update(2100.0),
                e(
                    [0.0, 0.871470904378763, 0.0, 0.49044720696652044],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    121.26004114292323,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (Op::Update(2620.0), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("skipped"), false, None, &[])),
            (Op::Update(2700.0), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("skipped"), false, None, &[])),
            (
                Op::Toggle(3000.0),
                e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, false, Some("skipped"), true, None, &[Ev::Flip(false)]),
            ),
            (
                Op::Update(3100.0),
                e(
                    [0.0, 0.4912774462448956, 0.0, -0.8710031405288351],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    301.15084191972426,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(3620.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[]),
            ),
            (
                Op::SetFlipped(false, 3700.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[Ev::Flip(false)]),
            ),
            (
                Op::SetFlipped(false, 3800.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[Ev::Flip(false)]),
            ),
            (
                Op::Update(3900.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[]),
            ),
            (
                Op::Update(4400.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[]),
            ),
        ],
    );
}

#[test]
fn flip_from_back_face_default() {
    run(
        InteractionOptions { default_flipped: true, play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("skipped"), false, None, &[])),
            (
                Op::Toggle(1000.0),
                e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, false, Some("skipped"), true, None, &[Ev::Flip(false)]),
            ),
            (
                Op::Update(1010.0),
                e(
                    [0.0, 0.9862286332565592, 0.0, -0.16538767470673044],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    199.03951202802185,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1300.0),
                e(
                    [0.0, 0.05486621361480533, 0.0, -0.9984937148543173],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    353.70963636630955,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1700.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[]),
            ),
            (
                Op::SetFlipped(true, 1800.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, true, Some("skipped"), true, None, &[Ev::Flip(true)]),
            ),
            (
                Op::Update(1900.0),
                e(
                    [0.0, -0.8710031405288353, 0.0, -0.4912774462448953],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    481.15084191972426,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2500.0),
                e([0.0, -1.0, 0.0, -1.8369701987210297e-16], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 540.0, true, Some("skipped"), false, None, &[]),
            ),
        ],
    );
}

#[test]
fn reset_mid_flip_after_drag() {
    run(
        InteractionOptions { default_rotation: CardRotation { x: 4.0, y: 12.0 }, play_intro: false, ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(1, 100.0, 100.0, 400.0, 250.0, 1000.0),
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Move(1, 160.0, 130.0, 1010.0),
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Up(1, 160.0, 130.0, 1020.0),
                e(
                    [-0.08911492926465102, -0.1814855167112126, 0.016516475879051664, 0.9792082223055304],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-10.399999999999999, -21.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(-10.399999999999999, -21.0)],
                ),
            ),
            (
                Op::Toggle(1030.0),
                e(
                    [-0.08911492926465102, -0.1814855167112126, 0.016516475879051664, 0.9792082223055304],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-10.399999999999999, -21.0],
                    0.0,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[Ev::Flip(true)],
                ),
            ),
            (
                Op::Update(1100.0),
                e(
                    [-0.07107726954958207, 0.6179099396765336, -0.05623420975423326, 0.7810077092165195],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-10.399999999999999, -21.0],
                    97.69998215994737,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1300.0),
                e(
                    [-0.02330232844636068, 0.9624055264740321, -0.0875857641531144, 0.2560494835357685],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-10.399999999999999, -21.0],
                    171.2029830814749,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Reset,
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("reset"),
                    false,
                    None,
                    &[Ev::Flip(false), Ev::Rot(4.0, 12.0)],
                ),
            ),
            (
                Op::Update(1330.0),
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("reset"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2000.0),
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("reset"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Reset,
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("reset"),
                    false,
                    None,
                    &[Ev::Rot(4.0, 12.0)],
                ),
            ),
            (
                Op::DblClick,
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("reset"),
                    false,
                    None,
                    &[Ev::Rot(4.0, 12.0)],
                ),
            ),
            (
                Op::Update(2300.0),
                e(
                    [0.03470831360797007, 0.10446478735209537, 0.003647990759126966, 0.9939160595006973],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [4.0, 12.0],
                    0.0,
                    false,
                    Some("reset"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn reset_cancels_intro_and_interrupt() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1800.0),
                e(
                    [-0.04405635598185764, -0.27717406384082793, -0.09531586284754892, 0.9550646376665758],
                    [0.0, -0.20318955443783976, 0.0],
                    1.0,
                    [-9.235888838083625, -31.402022049484327],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(1, 10.0, 10.0, 400.0, 250.0, 1900.0),
                e(
                    [-0.04405635598185764, -0.27717406384082793, -0.09531586284754892, 0.9550646376665758],
                    [0.0, -0.20318955443783976, 0.0],
                    1.0,
                    [-9.235888838083625, -31.402022049484327],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(1950.0),
                e(
                    [-0.04405635598185764, -0.27717406384082793, -0.09531586284754892, 0.9550646376665758],
                    [0.0, -0.06879264529427004, 0.0],
                    1.0,
                    [-9.235888838083625, -31.402022049484327],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (Op::Reset, e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, None, &[Ev::Rot(0.0, 0.0)])),
            (Op::Update(1970.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, None, &[])),
            (Op::Update(2500.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, None, &[])),
        ],
    );
}

#[test]
fn keyboard() {
    run(
        InteractionOptions { play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::Key("Enter", 1000.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, true, Some("skipped"), true, Some(true), &[Ev::Flip(true)]),
            ),
            (
                Op::Update(1100.0),
                e(
                    [0.0, 0.8710031405288352, 0.0, 0.4912774462448954],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    121.15084191972426,
                    true,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (Op::Update(1700.0), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("skipped"), false, None, &[])),
            (
                Op::Key(" ", 1800.0),
                e(
                    [0.0, 1.0, 0.0, 6.123233995736766e-17],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    180.0,
                    false,
                    Some("skipped"),
                    true,
                    Some(true),
                    &[Ev::Flip(false)],
                ),
            ),
            (
                Op::Update(1900.0),
                e(
                    [0.0, 0.4912774462448956, 0.0, -0.8710031405288351],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    301.15084191972426,
                    false,
                    Some("skipped"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2500.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, None, &[]),
            ),
            (
                Op::Key("a", 2600.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, Some(false), &[]),
            ),
            (
                Op::Key("ArrowLeft", 2610.0),
                e([0.0, 1.2246467991473532e-16, 0.0, -1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 360.0, false, Some("skipped"), false, Some(false), &[]),
            ),
            (
                Op::SetRotation(20.0, 30.0),
                e(
                    [-0.16773125949652062, -0.25488700224417865, -0.044943455527547756, -0.9512512425641977],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [20.0, 30.0],
                    360.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Key("Home", 2700.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, Some(true), &[Ev::Rot(0.0, 0.0)]),
            ),
            (Op::Update(2800.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, None, &[])),
            (
                Op::SetRotation(-20.0, 30.0),
                e(
                    [-0.16773125949652062, 0.25488700224417876, -0.044943455527547777, 0.9512512425641977],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-20.0, 30.0],
                    0.0,
                    false,
                    Some("reset"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Key("Escape", 2900.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, Some(true), &[Ev::Rot(0.0, 0.0)]),
            ),
            (Op::Key("Tab", 2950.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, Some(false), &[])),
        ],
    );
}

#[test]
fn keyboard_interrupts_the_intro() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1500.0),
                e(
                    [-0.046347488363492874, -0.29304931931050415, -0.09211233368612215, 0.9505205546209626],
                    [0.0, -0.21526553490004063, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Key("Enter", 1600.0),
                e(
                    [-0.046347488363492874, -0.29304931931050415, -0.09211233368612215, 0.9505205546209626],
                    [0.0, -0.21526553490004063, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    true,
                    Some("interrupting"),
                    true,
                    Some(true),
                    &[Ev::Flip(true)],
                ),
            ),
            (
                Op::Update(1650.0),
                e(
                    [-0.07912745924380578, 0.37171053114356456, -0.03181715667034143, 0.924422952317825],
                    [0.0, -0.0728811361756793, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    77.0784354255648,
                    true,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1700.0),
                e(
                    [-0.06140940390270038, 0.6913923924047434, -0.059180836233363614, 0.7174280963691623],
                    [0.0, -0.024674920733244194, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    121.15084191972426,
                    true,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1800.0),
                e(
                    [-0.037726107922833, 0.8935726336164147, -0.07648677693536285, 0.44074307956774483],
                    [0.0, -0.0028283752597674685, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    160.75986996245953,
                    true,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1920.0),
                e(
                    [-0.02797583192097677, 0.9412260113170553, -0.08056574391945037, 0.32683345813306997],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    174.96998475087568,
                    true,
                    Some("interrupted"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2300.0),
                e(
                    [-0.024413573565891494, 0.9546611881708551, -0.08171574934312235, 0.2852166361474133],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    180.0,
                    true,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(5000.0),
                e(
                    [-0.024413573565891494, 0.9546611881708551, -0.08171574934312235, 0.2852166361474133],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    180.0,
                    true,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Key("Escape", 5100.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, Some(true), &[Ev::Flip(false), Ev::Rot(0.0, 0.0)]),
            ),
            (Op::Update(5200.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, None, &[])),
        ],
    );
}

#[test]
fn keyboard_ignored_when_not_interactive_or_inactive() {
    run(
        InteractionOptions { interactive: false, play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (Op::Key("Enter", 1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(false), &[])),
            (
                Op::Down(1, 10.0, 10.0, 400.0, 250.0, 1001.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(false), &[]),
            ),
            (Op::Move(1, 50.0, 50.0, 1002.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(false), &[])),
            (Op::Update(1010.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (Op::DblClick, e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (Op::SetActive(true, 1030.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (Op::Key("Enter", 1040.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(false), &[])),
        ],
    );
}

#[test]
fn inactive_card() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1500.0),
                e(
                    [-0.046347488363492874, -0.29304931931050415, -0.09211233368612215, 0.9505205546209626],
                    [0.0, -0.21526553490004063, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetActive(false, 1600.0),
                e(
                    [-0.08171574934312235, -0.28521663614741327, 0.02441357356589149, 0.9546611881708551],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1700.0),
                e(
                    [-0.08171574934312235, -0.28521663614741327, 0.02441357356589149, 0.9546611881708551],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(1, 10.0, 10.0, 400.0, 250.0, 1800.0),
                e(
                    [-0.08171574934312235, -0.28521663614741327, 0.02441357356589149, 0.9546611881708551],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    false,
                    Some(false),
                    &[],
                ),
            ),
            (
                Op::Key("Enter", 1810.0),
                e(
                    [-0.08171574934312235, -0.28521663614741327, 0.02441357356589149, 0.9546611881708551],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    false,
                    Some(false),
                    &[],
                ),
            ),
            (
                Op::SetActive(true, 1900.0),
                e(
                    [-0.08171574934312235, -0.28521663614741327, 0.02441357356589149, 0.9546611881708551],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2000.0),
                e(
                    [-0.08171574934312235, -0.28521663614741327, 0.02441357356589149, 0.9546611881708551],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2500.0),
                e(
                    [-0.08171574934312235, -0.28521663614741327, 0.02441357356589149, 0.9546611881708551],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Key("Enter", 2600.0),
                e(
                    [-0.08171574934312235, -0.28521663614741327, 0.02441357356589149, 0.9546611881708551],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    true,
                    Some("running"),
                    true,
                    Some(true),
                    &[Ev::Flip(true)],
                ),
            ),
        ],
    );
}

#[test]
fn rotation_mode_front_clamps_yaw() {
    run(
        InteractionOptions { rotation_mode: RotationMode::Front, play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::Down(1, 200.0, 125.0, 400.0, 250.0, 1000.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(true), &[]),
            ),
            (Op::Move(1, 380.0, 125.0, 1010.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), true, Some(true), &[])),
            (
                Op::Update(1016.0),
                e(
                    [0.0, -0.5591929034707469, 0.0, 0.8290375725550416],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, -68.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(0.0, -68.0)],
                ),
            ),
            (
                Op::Move(1, 20.0, 125.0, 1020.0),
                e([0.0, -0.5591929034707469, 0.0, 0.8290375725550416], [0.0, 0.0, 0.0], 1.0, [0.0, -68.0], 0.0, false, Some("skipped"), true, Some(true), &[]),
            ),
            (
                Op::Update(1032.0),
                e(
                    [0.0, 0.5591929034707469, 0.0, 0.8290375725550416],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 68.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(0.0, 68.0)],
                ),
            ),
            (
                Op::Move(1, 200.0, 120.0, 1040.0),
                e([0.0, 0.5591929034707469, 0.0, 0.8290375725550416], [0.0, 0.0, 0.0], 1.0, [0.0, 68.0], 0.0, false, Some("skipped"), true, Some(true), &[]),
            ),
            (
                Op::Update(1048.0),
                e(
                    [0.020942419883356957, 0.0, 0.0, 0.9997806834748455],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [2.4, 0.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(2.4, 0.0)],
                ),
            ),
            (
                Op::Up(1, 200.0, 120.0, 1050.0),
                e([0.020942419883356957, 0.0, 0.0, 0.9997806834748455], [0.0, 0.0, 0.0], 1.0, [2.4, 0.0], 0.0, false, Some("skipped"), false, None, &[]),
            ),
        ],
    );
}

#[test]
fn rotation_mode_full_with_yaw_direction_positive() {
    run(
        InteractionOptions { yaw_direction: 1.0, play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::Down(1, 200.0, 125.0, 400.0, 250.0, 1000.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, Some(true), &[]),
            ),
            (Op::Move(1, 380.0, 125.0, 1010.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), true, Some(true), &[])),
            (
                Op::Update(1016.0),
                e(
                    [0.0, 0.7604059656000309, 0.0, 0.6494480483301837],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 99.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(0.0, 99.0)],
                ),
            ),
            (
                Op::Move(1, 20.0, 125.0, 1020.0),
                e([0.0, 0.7604059656000309, 0.0, 0.6494480483301837], [0.0, 0.0, 0.0], 1.0, [0.0, 99.0], 0.0, false, Some("skipped"), true, Some(true), &[]),
            ),
            (
                Op::Update(1032.0),
                e(
                    [0.0, -0.7604059656000309, 0.0, 0.6494480483301837],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, -99.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[Ev::Rot(0.0, -99.0)],
                ),
            ),
            (
                Op::Up(1, 20.0, 125.0, 1050.0),
                e([0.0, -0.7604059656000309, 0.0, 0.6494480483301837], [0.0, 0.0, 0.0], 1.0, [0.0, -99.0], 0.0, false, Some("skipped"), false, None, &[]),
            ),
        ],
    );
}

#[test]
fn fit_to_viewport_scale_per_aspect() {
    run(
        InteractionOptions { fit_to_viewport: true, play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (Op::Aspect(300.0, 300.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::SetRotation(0.0, 0.0),
                e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 0.8609919683472859, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[]),
            ),
            (
                Op::SetRotation(25.0, 40.0),
                e(
                    [0.20338670806338613, 0.3339129002834377, 0.07402670778046234, 0.9174181535933481],
                    [0.0, 0.0, 0.0],
                    0.8609919683472859,
                    [25.0, 40.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetRotation(25.0, 80.0),
                e(
                    [0.1658023635281006, 0.6275509767631344, 0.1391247020847505, 0.7478861310934711],
                    [0.0, 0.0, 0.0],
                    0.8609919683472859,
                    [25.0, 80.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Aspect(800.0, 600.0),
                e(
                    [0.1658023635281006, 0.6275509767631344, 0.1391247020847505, 0.7478861310934711],
                    [0.0, 0.0, 0.0],
                    0.8609919683472859,
                    [25.0, 80.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetRotation(25.0, 80.0),
                e(
                    [0.1658023635281006, 0.6275509767631344, 0.1391247020847505, 0.7478861310934711],
                    [0.0, 0.0, 0.0],
                    0.7491530048504238,
                    [25.0, 80.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Aspect(1000.0, 1000.0),
                e(
                    [0.1658023635281006, 0.6275509767631344, 0.1391247020847505, 0.7478861310934711],
                    [0.0, 0.0, 0.0],
                    0.7491530048504238,
                    [25.0, 80.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetRotation(25.0, 80.0),
                e(
                    [0.1658023635281006, 0.6275509767631344, 0.1391247020847505, 0.7478861310934711],
                    [0.0, 0.0, 0.0],
                    0.7491530048504238,
                    [25.0, 80.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Aspect(1001.0, 1000.0),
                e(
                    [0.1658023635281006, 0.6275509767631344, 0.1391247020847505, 0.7478861310934711],
                    [0.0, 0.0, 0.0],
                    0.7491530048504238,
                    [25.0, 80.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetRotation(25.0, 80.0),
                e(
                    [0.1658023635281006, 0.6275509767631344, 0.1391247020847505, 0.7478861310934711],
                    [0.0, 0.0, 0.0],
                    0.7491530048504238,
                    [25.0, 80.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Aspect(700.0, 1000.0),
                e(
                    [0.1658023635281006, 0.6275509767631344, 0.1391247020847505, 0.7478861310934711],
                    [0.0, 0.0, 0.0],
                    0.7491530048504238,
                    [25.0, 80.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (Op::SetRotation(0.0, 0.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 0.68, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::SetRotation(35.0, 50.0),
                e(
                    [0.27253200769780433, 0.4030581999178559, 0.12708376228184318, 0.8643610990919672],
                    [0.0, 0.0, 0.0],
                    0.68,
                    [35.0, 50.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Aspect(1600.0, 1000.0),
                e(
                    [0.27253200769780433, 0.4030581999178559, 0.12708376228184318, 0.8643610990919672],
                    [0.0, 0.0, 0.0],
                    0.68,
                    [35.0, 50.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (Op::SetRotation(0.0, 0.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::SetRotation(68.0, 90.0),
                e(
                    [0.3954090940355596, 0.5862180894121043, 0.39540909403555957, 0.5862180894121044],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [68.0, 90.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Aspect(0.0, 0.0),
                e(
                    [0.3954090940355596, 0.5862180894121043, 0.39540909403555957, 0.5862180894121044],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [68.0, 90.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetRotation(10.0, 10.0),
                e(
                    [0.08682408883346517, 0.08682408883346517, 0.007596123493895969, 0.9924038765061041],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [10.0, 10.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Aspect(1000.0, 1000.0),
                e(
                    [0.08682408883346517, 0.08682408883346517, 0.007596123493895969, 0.9924038765061041],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [10.0, 10.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetRotation(0.0, 90.0),
                e(
                    [0.0, 0.7071067811865475, 0.0, 0.7071067811865476],
                    [0.0, 0.0, 0.0],
                    0.9645856037298108,
                    [0.0, 90.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn fit_to_viewport_intro_flip_and_drag() {
    run(
        InteractionOptions { default_rotation: CardRotation { x: 20.0, y: 30.0 }, fit_to_viewport: true, ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    0.939006127173597,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    0.939006127173597,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1500.0),
                e(
                    [-0.0435625485511095, -0.28737253969190907, -0.09384368709747572, 0.9522146240143055],
                    [0.0, -0.21526553490004063, 0.0],
                    0.939006127173597,
                    [-9.354391122732816, -32.62270106183001],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(3000.0),
                e(
                    [0.06664703590505128, 0.046350800854300496, -0.08727360139293926, 0.9928711368375768],
                    [0.0, -0.0872712493014276, 0.0],
                    0.939006127173597,
                    [8.09937509525987, 4.612000203221058],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4600.0),
                e(
                    [0.16773125949652062, 0.25488700224417876, 0.044943455527547777, 0.9512512425641977],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [20.0, 30.0],
                    0.0,
                    false,
                    Some("complete"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Toggle(4700.0),
                e(
                    [0.16773125949652062, 0.25488700224417876, 0.044943455527547777, 0.9512512425641977],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [20.0, 30.0],
                    0.0,
                    true,
                    Some("complete"),
                    true,
                    None,
                    &[Ev::Flip(true)],
                ),
            ),
            (
                Op::Update(4800.0),
                e(
                    [0.043256693910178355, 0.95376305524891, 0.16817415984332118, 0.24532090174956261],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [20.0, 30.0],
                    121.15084191972426,
                    true,
                    Some("complete"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(5000.0),
                e(
                    [-0.03567297875467458, 0.9638030716604774, 0.16994448562343628, -0.20231151586299476],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [20.0, 30.0],
                    173.70963636630955,
                    true,
                    Some("complete"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(5400.0),
                e(
                    [-0.04494345552754777, 0.9512512425641977, 0.16773125949652062, -0.2548870022441787],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [20.0, 30.0],
                    180.0,
                    true,
                    Some("complete"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(1, 10.0, 10.0, 400.0, 250.0, 5500.0),
                e(
                    [-0.04494345552754777, 0.9512512425641977, 0.16773125949652062, -0.2548870022441787],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [20.0, 30.0],
                    180.0,
                    true,
                    Some("complete"),
                    false,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Move(1, 90.0, 60.0, 5510.0),
                e(
                    [-0.04494345552754777, 0.9512512425641977, 0.16773125949652062, -0.2548870022441787],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [20.0, 30.0],
                    180.0,
                    true,
                    Some("complete"),
                    true,
                    Some(true),
                    &[],
                ),
            ),
            (
                Op::Update(5520.0),
                e(
                    [-0.004253178748303904, 0.9919415193434417, -0.034639361146286345, 0.12179510389394457],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [-4.0, -14.0],
                    180.0,
                    true,
                    Some("complete"),
                    false,
                    None,
                    &[Ev::Rot(-4.0, -14.0)],
                ),
            ),
            (
                Op::Up(1, 90.0, 60.0, 5530.0),
                e(
                    [-0.004253178748303904, 0.9919415193434417, -0.034639361146286345, 0.12179510389394457],
                    [0.0, 0.0, 0.0],
                    0.939006127173597,
                    [-4.0, -14.0],
                    180.0,
                    true,
                    Some("complete"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn fit_to_viewport_aspect_nonfinite_first() {
    run(
        InteractionOptions { fit_to_viewport: true, play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (Op::Aspect(0.0, 0.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::SetRotation(30.0, 30.0),
                e(
                    [0.24999999999999997, 0.24999999999999997, 0.06698729810778066, 0.9330127018922194],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [30.0, 30.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Aspect(800.0, 600.0),
                e(
                    [0.24999999999999997, 0.24999999999999997, 0.06698729810778066, 0.9330127018922194],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [30.0, 30.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetRotation(30.0, 30.0),
                e(
                    [0.24999999999999997, 0.24999999999999997, 0.06698729810778066, 0.9330127018922194],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [30.0, 30.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn reduced_motion_skips_intro_and_flips_instantly() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Toggle(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[Ev::Flip(true)],
                ),
            ),
            (
                Op::Update(1100.0),
                e(
                    [-0.06312490914312277, 0.686730874843317, -0.06006875667417706, 0.7216700741018873],
                    [0.0, -0.2199547892692933, 0.0],
                    1.0,
                    [-9.99794496678606, -33.9930128870726],
                    121.15084191972426,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Toggle(1200.0),
                e(
                    [-0.06312490914312277, 0.686730874843317, -0.06006875667417706, 0.7216700741018873],
                    [0.0, -0.2199547892692933, 0.0],
                    1.0,
                    [-9.99794496678606, -33.9930128870726],
                    121.15084191972426,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[Ev::Flip(false)],
                ),
            ),
            (
                Op::Reduced(false),
                e(
                    [-0.06312490914312277, 0.686730874843317, -0.06006875667417706, 0.7216700741018873],
                    [0.0, -0.2199547892692933, 0.0],
                    1.0,
                    [-9.99794496678606, -33.9930128870726],
                    121.15084191972426,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Toggle(1300.0),
                e(
                    [-0.06312490914312277, 0.686730874843317, -0.06006875667417706, 0.7216700741018873],
                    [0.0, -0.2199547892692933, 0.0],
                    1.0,
                    [-9.99794496678606, -33.9930128870726],
                    121.15084191972426,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[Ev::Flip(true)],
                ),
            ),
            (
                Op::Update(1400.0),
                e(
                    [-0.030830176340824595, 0.9303059293188376, -0.08044785433642951, 0.3565228195132424],
                    [0.0, -0.21746278514454098, 0.0],
                    1.0,
                    [-9.88467205202459, -33.607884976883604],
                    171.67104230972657,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2000.0),
                e(
                    [-0.019145344398765175, 0.9644872485982202, -0.07294749769284599, 0.2531332962287655],
                    [0.0, -0.19031067418584566, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    180.0,
                    true,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn intro_already_played_only_orients() {
    run(
        InteractionOptions {
            default_rotation: CardRotation { x: 9.0, y: 9.0 },
            rotation: Some(CardRotation { x: 3.0, y: 4.0 }),
            intro_played: true,
            ..Default::default()
        },
        &[
            (
                Op::Start(1000.0),
                e(
                    [0.02616100201824147, 0.0348875375166154, 0.0009135623211521574, 0.9990483607430192],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [3.0, 4.0],
                    0.0,
                    false,
                    None,
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [0.02616100201824147, 0.0348875375166154, 0.0009135623211521574, 0.9990483607430192],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [3.0, 4.0],
                    0.0,
                    false,
                    None,
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1500.0),
                e(
                    [0.02616100201824147, 0.0348875375166154, 0.0009135623211521574, 0.9990483607430192],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [3.0, 4.0],
                    0.0,
                    false,
                    None,
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn play_intro_false_skips() {
    run(
        InteractionOptions {
            default_rotation: CardRotation { x: 9.0, y: 9.0 },
            rotation: Some(CardRotation { x: 3.0, y: 4.0 }),
            play_intro: false,
            ..Default::default()
        },
        &[
            (
                Op::Start(1000.0),
                e(
                    [0.02616100201824147, 0.0348875375166154, 0.0009135623211521574, 0.9990483607430192],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [3.0, 4.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [0.02616100201824147, 0.0348875375166154, 0.0009135623211521574, 0.9990483607430192],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [3.0, 4.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1100.0),
                e(
                    [0.02616100201824147, 0.0348875375166154, 0.0009135623211521574, 0.9990483607430192],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [3.0, 4.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn restart_intro_after_reset_does_nothing_once_played() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1500.0),
                e(
                    [-0.046347488363492874, -0.29304931931050415, -0.09211233368612215, 0.9505205546209626],
                    [0.0, -0.21526553490004063, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (Op::Reset, e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, None, &[Ev::Rot(0.0, 0.0)])),
            (Op::StartIntro(1700.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, None, &[])),
            (Op::Update(1800.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("reset"), false, None, &[])),
        ],
    );
}

#[test]
fn hidden_document_ends_the_intro_and_drag_and_flip() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1500.0),
                e(
                    [-0.046347488363492874, -0.29304931931050415, -0.09211233368612215, 0.9505205546209626],
                    [0.0, -0.21526553490004063, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Visible(false),
                e(
                    [-0.046347488363492874, -0.29304931931050415, -0.09211233368612215, 0.9505205546209626],
                    [0.0, -0.21526553490004063, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Down(1, 10.0, 10.0, 400.0, 250.0, 1610.0),
                e(
                    [-0.046347488363492874, -0.29304931931050415, -0.09211233368612215, 0.9505205546209626],
                    [0.0, -0.21526553490004063, 0.0],
                    1.0,
                    [-9.784797040910938, -33.26830993909719],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    Some(false),
                    &[],
                ),
            ),
            (Op::Update(1700.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("complete"), false, None, &[])),
            (Op::Visible(true), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("complete"), false, None, &[])),
            (Op::Toggle(1900.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, true, Some("complete"), true, None, &[Ev::Flip(true)])),
            (
                Op::Update(2000.0),
                e(
                    [0.0, 0.8710031405288352, 0.0, 0.4912774462448954],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    121.15084191972426,
                    true,
                    Some("complete"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Visible(false),
                e(
                    [0.0, 0.8710031405288352, 0.0, 0.4912774462448954],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [0.0, 0.0],
                    121.15084191972426,
                    true,
                    Some("complete"),
                    true,
                    None,
                    &[],
                ),
            ),
            (Op::Update(2100.0), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("complete"), false, None, &[])),
            (Op::Visible(true), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("complete"), false, None, &[])),
            (
                Op::Down(1, 10.0, 10.0, 400.0, 250.0, 2300.0),
                e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("complete"), false, Some(true), &[]),
            ),
            (Op::Visible(false), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("complete"), false, None, &[])),
            (
                Op::Move(1, 90.0, 90.0, 2320.0),
                e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("complete"), false, Some(false), &[]),
            ),
            (
                Op::Up(1, 90.0, 90.0, 2330.0),
                e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("complete"), false, None, &[]),
            ),
            (Op::Update(2400.0), e([0.0, 1.0, 0.0, 6.123233995736766e-17], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 180.0, true, Some("complete"), false, None, &[])),
        ],
    );
}

#[test]
fn set_rotation_applies_without_a_callback() {
    run(
        InteractionOptions { play_intro: false, ..Default::default() },
        &[
            (Op::Start(1000.0), e([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 1.0, [0.0, 0.0], 0.0, false, Some("skipped"), false, None, &[])),
            (
                Op::SetRotation(12.0, -34.0),
                e(
                    [0.09996106655636447, -0.29077006193290933, -0.030561164997611818, 0.951066018450052],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [12.0, -34.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::SetRotation(100.0, 400.0),
                e(
                    [-0.7198463103929542, -0.21984631039295416, -0.2620026302293849, -0.6040227735550537],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [100.0, 400.0],
                    0.0,
                    false,
                    Some("skipped"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}

#[test]
fn interrupt_intro_directly() {
    run(
        InteractionOptions { ..Default::default() },
        &[
            (
                Op::Start(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(1000.0),
                e(
                    [-0.04723063162548542, -0.2992456398027291, -0.09080881164767912, 0.9486701609213021],
                    [0.0, -0.22, 0.0],
                    1.0,
                    [-10.0, -34.0],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2000.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.19031067418584566, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("running"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Interrupt(2100.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.19031067418584566, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Interrupt(2150.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.19031067418584566, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2200.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.021814457211678417, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2300.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, -0.0025004931829280567, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupting"),
                    true,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2420.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(2500.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
            (
                Op::Update(4000.0),
                e(
                    [-0.04155456950151816, -0.2601365426710196, -0.09853878980446024, 0.9596313374544335],
                    [0.0, 0.0, 0.0],
                    1.0,
                    [-8.650485190265712, -29.41164964690342],
                    0.0,
                    false,
                    Some("interrupted"),
                    false,
                    None,
                    &[],
                ),
            ),
        ],
    );
}
