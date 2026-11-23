//! The adaptive-resolution controller against `scene/adaptive-resolution.test.ts`, case by case.

use card3d_engine::adaptive::{AdaptiveResolution, AdaptiveResolutionConfig, AdaptiveResolutionPatch, Direction};

struct Change {
    t: f64,
    ratio: f64,
    direction: Direction,
}

/// Feed `seconds` of frames at `fps`, each costing cost(ratio) ms; returns the changes.
fn run(ctl: &mut AdaptiveResolution, from: f64, seconds: f64, mut cost: impl FnMut(f64) -> f64, fps: f64) -> Vec<Change> {
    let mut changes = Vec::new();
    let mut t = from;
    while t < from + seconds {
        let ms = cost(ctl.ratio());
        if let Some(c) = ctl.sample(ms, t) {
            changes.push(Change { t, ratio: c.ratio, direction: c.direction });
        }
        t += 1.0 / fps;
    }
    changes
}

fn run60(ctl: &mut AdaptiveResolution, from: f64, seconds: f64, cost: impl FnMut(f64) -> f64) -> Vec<Change> {
    run(ctl, from, seconds, cost, 60.0)
}

/// GPU cost proportional to the pixel count.
fn gpu(ms_at_one: f64) -> impl Fn(f64) -> f64 {
    move |r| ms_at_one * r * r
}

fn ctl(max: f64, min: f64, budget_ms: f64) -> AdaptiveResolution {
    AdaptiveResolution::new(AdaptiveResolutionConfig::new(max, min, budget_ms))
}

fn ratios(changes: &[Change]) -> Vec<f64> {
    changes.iter().map(|c| c.ratio).collect()
}

#[test]
fn lists_levels_from_max_down_to_min_on_the_step_grid() {
    assert_eq!(ctl(2.0, 1.0, 14.0).levels(), vec![2.0, 1.75, 1.5, 1.25, 1.0]);
    assert_eq!(ctl(1.6, 1.0, 14.0).levels(), vec![1.6, 1.35, 1.1, 1.0]);
    assert_eq!(ctl(1.0, 1.0, 14.0).levels(), vec![1.0]);
}

#[test]
fn stays_at_full_ratio_within_budget() {
    let mut c = ctl(2.0, 1.0, 14.0);
    assert!(run60(&mut c, 0.0, 20.0, gpu(2.5)).is_empty()); // 10 ms at 2
    assert_eq!(c.ratio(), 2.0);
}

#[test]
fn ignores_short_spikes_median_sustained_for_down_after() {
    let mut c = ctl(2.0, 1.0, 14.0);
    let mut i = 0;
    let changes = run60(&mut c, 0.0, 10.0, |_| {
        let ms = if i % 10 == 0 { 80.0 } else { 8.0 };
        i += 1;
        ms
    });
    assert!(changes.is_empty());
    // a 0.5 s burst over budget is not sustained either
    assert!(run60(&mut c, 10.0, 0.5, |_| 30.0).is_empty());
    assert!(run60(&mut c, 10.5, 5.0, |_| 8.0).is_empty());
}

#[test]
fn jumps_down_to_the_level_predicted_to_fit_after_about_down_after() {
    let mut c = ctl(2.0, 1.0, 14.0);
    let changes = run60(&mut c, 0.0, 3.0, gpu(5.0)); // 20 ms at 2 → want 2·sqrt(12.6/20) ≈ 1.59 → 1.5
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].ratio, 1.5);
    assert_eq!(changes[0].direction, Direction::Down);
    assert!(changes[0].t > 1.0);
    assert!(changes[0].t < 1.5);
}

#[test]
fn never_goes_below_min() {
    let mut c = ctl(2.0, 1.0, 14.0);
    run60(&mut c, 0.0, 30.0, gpu(40.0));
    assert_eq!(c.ratio(), 1.0);
}

#[test]
fn settles_without_oscillating_when_the_cost_hovers_around_the_budget() {
    let mut c = ctl(2.0, 1.0, 14.0);
    let changes = run60(&mut c, 0.0, 120.0, gpu(3.6)); // 14.4 ms at 2 (just over), 11 ms at 1.75
    assert_eq!(ratios(&changes), vec![1.75]);
}

#[test]
fn steps_back_up_one_level_at_a_time_once_there_is_headroom_for_up_after() {
    let mut c = ctl(2.0, 1.0, 14.0);
    run60(&mut c, 0.0, 5.0, gpu(10.0)); // heavy: down to 1
    assert_eq!(c.ratio(), 1.0);
    let changes = run60(&mut c, 5.0, 40.0, gpu(1.0)); // light: 4 ms at 2
    assert_eq!(ratios(&changes), vec![1.25, 1.5, 1.75, 2.0]);
    assert!(changes.iter().all(|c| c.direction == Direction::Up));
    for i in 1..changes.len() {
        assert!(changes[i].t - changes[i - 1].t >= 3.0);
    }
}

#[test]
fn does_not_step_up_when_the_next_level_is_predicted_over_budget_times_up_headroom() {
    let mut c = ctl(2.0, 1.0, 14.0);
    run60(&mut c, 0.0, 3.0, gpu(4.0)); // 16 ms at 2 → down
    assert!(c.ratio() < 2.0);
    let r = c.ratio();
    assert!(run60(&mut c, 3.0, 60.0, gpu(4.0)).is_empty()); // 16·(2/r)² ... stays
    assert_eq!(c.ratio(), r);
}

#[test]
fn non_predictive_probes_up_and_blocks_a_failing_level_with_growing_back_off() {
    let mut cfg = AdaptiveResolutionConfig::new(2.0, 1.0, 20.0);
    cfg.predictive = Some(false);
    let mut c = AdaptiveResolution::new(cfg);
    // 60 Hz vsync; anything above 1.5 can't keep up (33 ms intervals)
    let interval = |r: f64| if r > 1.5 { 33.3 } else { 16.7 };
    let changes = run60(&mut c, 0.0, 200.0, interval);
    let ups: Vec<&Change> = changes.iter().filter(|c| c.direction == Direction::Up).collect();
    assert_eq!(c.ratio(), 1.5);
    // one step at a time down to 1.5, then at most max_retries (3) failed probes of 1.75, spaced out
    assert!(ups.len() <= 3);
    for i in 1..ups.len() {
        assert!(ups[i].t - ups[i - 1].t > 8.0);
    }
    // and after that it stays put for good
    assert!(run60(&mut c, 200.0, 300.0, interval).is_empty());
}

#[test]
fn reset_returns_to_max_and_forgets_blocked_levels() {
    let mut c = ctl(2.0, 1.0, 14.0);
    run60(&mut c, 0.0, 5.0, gpu(10.0));
    assert_eq!(c.ratio(), 1.0);
    c.reset();
    assert_eq!(c.ratio(), 2.0);
    c.reset_with(&AdaptiveResolutionPatch { max: Some(1.25), ..Default::default() });
    assert_eq!(c.ratio(), 1.25);
    assert_eq!(c.levels(), vec![1.25, 1.0]);
}

#[test]
fn ignores_samples_while_settling_after_a_change_and_junk_samples() {
    let mut cfg = AdaptiveResolutionConfig::new(2.0, 1.0, 14.0);
    cfg.settle = Some(1.0);
    let mut c = AdaptiveResolution::new(cfg);
    let ch = run60(&mut c, 0.0, 2.0, gpu(10.0));
    assert_eq!(ch.len(), 1);
    let t = ch[0].t;
    let mut x = t;
    while x < t + 0.99 {
        assert!(c.sample(1000.0, x).is_none());
        x += 1.0 / 60.0;
    }
    assert!(c.sample(f64::NAN, 100.0).is_none());
    assert!(c.sample(-1.0, 100.0).is_none());
}

// ── additions ────────────────────────────────────────────────────────────────

#[test]
fn change_reports_previous_ratio_median_and_direction() {
    let mut c = ctl(2.0, 1.0, 14.0);
    let mut change = None;
    let mut t = 0.0;
    while change.is_none() && t < 3.0 {
        change = c.sample(20.0, t);
        t += 1.0 / 60.0;
    }
    let change = change.expect("steps down");
    assert_eq!((change.ratio, change.previous, change.frame_ms), (1.5, 2.0, 20.0));
    assert_eq!(change.direction.as_str(), "down");
}

#[test]
fn non_predictive_steps_down_one_level_at_a_time() {
    let mut cfg = AdaptiveResolutionConfig::new(2.0, 1.0, 20.0);
    cfg.predictive = Some(false);
    let mut c = AdaptiveResolution::new(cfg);
    let changes = run60(&mut c, 0.0, 30.0, |_| 50.0);
    assert_eq!(ratios(&changes), vec![1.75, 1.5, 1.25, 1.0]);
}

#[test]
fn clear_stats_keeps_the_ratio_but_restarts_the_timers() {
    let mut c = ctl(2.0, 1.0, 14.0);
    let changes = run60(&mut c, 0.0, 3.0, gpu(5.0));
    assert_eq!(changes.len(), 1);
    assert_eq!(c.ratio(), 1.5);
    c.clear_stats();
    assert_eq!(c.ratio(), 1.5);
}

#[test]
fn normalises_max_and_min() {
    let c = ctl(2.0, 3.0, 14.0); // min above max is clamped to max
    assert_eq!(c.config().min, 2.0);
    assert_eq!(c.levels(), vec![2.0]);
    let c = ctl(-1.0, -1.0, 14.0); // both floored to a tiny positive ratio
    assert_eq!((c.config().max, c.config().min), (1e-6, 1e-6));
    assert_eq!(c.config().step, 0.25);
    assert_eq!(c.config().window, 24);
}
