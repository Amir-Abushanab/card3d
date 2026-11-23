//! Adaptive resolution (`scene/adaptive-resolution.ts`): lower the device-pixel ratio while frames
//! cost more than a budget, raise it again when there is clear headroom. Pure logic (time is passed
//! in), so the stepping and hysteresis rules are unit-tested.
//!
//! `GpuFrameTimer` (WebGL timer queries) is not ported: the host measures frame costs and feeds them
//! to [`AdaptiveResolution::sample`], either GPU times (`predictive: true`) or frame intervals.
//!
//! Rules:
//! - Decisions use the median of the recent samples (robust to one-off spikes such as a texture upload).
//! - **Down** when the median stays above `budget_ms` for `down_after` s. With `predictive` costs (GPU
//!   time, which scales with the pixel count, i.e. ratio²) it jumps straight to the level expected to
//!   fit (`ratio·sqrt(0.9·budget / median)`, snapped down to the step grid); otherwise one step.
//! - **Up** one step when the median stays low enough for `up_after` s: predictive, the cost expected
//!   at the next level (`median·(next/ratio)²`) must be ≤ `budget·up_headroom`; non-predictive, the
//!   median must be ≤ `budget·up_headroom` and the step up is a probe.
//! - A level that had to be left downwards is **blocked** for `retry_after` s, doubling on every
//!   failure, and permanently after `max_retries` failures (until `reset`).
//! - After every change, samples are ignored for `settle` s.
//!
//! Like the TypeScript, a non-positive `step` makes [`AdaptiveResolution::levels`] loop forever; the
//! host never passes one.

use std::collections::{HashMap, VecDeque};

const EPS: f64 = 1e-6;

/// `AdaptiveResolutionConfig`. `None` takes the default noted on the field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AdaptiveResolutionConfig {
    /// Full (and highest) ratio.
    pub max: f64,
    /// Floor.
    pub min: f64,
    /// Ratio step (grid anchored at `max`; `min` is always a level). Default 0.25.
    pub step: Option<f64>,
    /// Frame cost budget, ms.
    pub budget_ms: f64,
    /// Costs scale with the pixel count (GPU time): jump to the predicted level, predict before stepping up. Default true.
    pub predictive: Option<bool>,
    /// Seconds above budget before stepping down. Default 1.
    pub down_after: Option<f64>,
    /// Seconds with headroom before stepping up. Default 3.
    pub up_after: Option<f64>,
    /// Fraction of the budget the (predicted) cost must stay under to step up. Default 0.8.
    pub up_headroom: Option<f64>,
    /// Seconds to ignore samples after a change. Default 0.5.
    pub settle: Option<f64>,
    /// Seconds a failed level stays blocked (doubles per failure). Default 8.
    pub retry_after: Option<f64>,
    /// Failures after which a level stays blocked until `reset`. Default 3.
    pub max_retries: Option<u32>,
    /// Samples in the median window. Default 24.
    pub window: Option<usize>,
}

impl AdaptiveResolutionConfig {
    /// The required fields, everything else at its default.
    pub fn new(max: f64, min: f64, budget_ms: f64) -> Self {
        AdaptiveResolutionConfig {
            max,
            min,
            step: None,
            budget_ms,
            predictive: None,
            down_after: None,
            up_after: None,
            up_headroom: None,
            settle: None,
            retry_after: None,
            max_retries: None,
            window: None,
        }
    }
}

/// `Partial<AdaptiveResolutionConfig>` for [`AdaptiveResolution::reset_with`]: the `Some` fields override.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AdaptiveResolutionPatch {
    pub max: Option<f64>,
    pub min: Option<f64>,
    pub step: Option<f64>,
    pub budget_ms: Option<f64>,
    pub predictive: Option<bool>,
    pub down_after: Option<f64>,
    pub up_after: Option<f64>,
    pub up_headroom: Option<f64>,
    pub settle: Option<f64>,
    pub retry_after: Option<f64>,
    pub max_retries: Option<u32>,
    pub window: Option<usize>,
}

/// `Required<AdaptiveResolutionConfig>`: the config with defaults filled in and `max` / `min` normalised.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedConfig {
    pub max: f64,
    pub min: f64,
    pub step: f64,
    pub budget_ms: f64,
    pub predictive: bool,
    pub down_after: f64,
    pub up_after: f64,
    pub up_headroom: f64,
    pub settle: f64,
    pub retry_after: f64,
    pub max_retries: u32,
    pub window: usize,
}

impl ResolvedConfig {
    /// `AdaptiveResolution.normalize`.
    fn normalize(cfg: &AdaptiveResolutionConfig) -> ResolvedConfig {
        let max = EPS.max(cfg.max);
        ResolvedConfig {
            step: cfg.step.unwrap_or(0.25),
            predictive: cfg.predictive.unwrap_or(true),
            down_after: cfg.down_after.unwrap_or(1.0),
            up_after: cfg.up_after.unwrap_or(3.0),
            up_headroom: cfg.up_headroom.unwrap_or(0.8),
            settle: cfg.settle.unwrap_or(0.5),
            retry_after: cfg.retry_after.unwrap_or(8.0),
            max_retries: cfg.max_retries.unwrap_or(3),
            window: cfg.window.unwrap_or(24),
            budget_ms: cfg.budget_ms,
            max,
            min: max.min(EPS.max(cfg.min)),
        }
    }

    /// `{ ...this.cfg, ...patch }`, as a config to normalise.
    fn merged(&self, p: &AdaptiveResolutionPatch) -> AdaptiveResolutionConfig {
        AdaptiveResolutionConfig {
            max: p.max.unwrap_or(self.max),
            min: p.min.unwrap_or(self.min),
            step: Some(p.step.unwrap_or(self.step)),
            budget_ms: p.budget_ms.unwrap_or(self.budget_ms),
            predictive: Some(p.predictive.unwrap_or(self.predictive)),
            down_after: Some(p.down_after.unwrap_or(self.down_after)),
            up_after: Some(p.up_after.unwrap_or(self.up_after)),
            up_headroom: Some(p.up_headroom.unwrap_or(self.up_headroom)),
            settle: Some(p.settle.unwrap_or(self.settle)),
            retry_after: Some(p.retry_after.unwrap_or(self.retry_after)),
            max_retries: Some(p.max_retries.unwrap_or(self.max_retries)),
            window: Some(p.window.unwrap_or(self.window)),
        }
    }
}

/// The direction of an [`AdaptiveResolutionChange`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Down,
    Up,
}

impl Direction {
    /// The TypeScript's `"down"` / `"up"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Down => "down",
            Direction::Up => "up",
        }
    }
}

/// `AdaptiveResolutionChange`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AdaptiveResolutionChange {
    pub ratio: f64,
    pub previous: f64,
    pub direction: Direction,
    /// Median frame cost (ms) that triggered the change.
    pub frame_ms: f64,
}

#[derive(Clone, Copy)]
struct Failure {
    count: u32,
    until: f64,
}

/// `AdaptiveResolution`.
#[derive(Clone, Debug)]
pub struct AdaptiveResolution {
    cfg: ResolvedConfig,
    current: f64,
    samples: VecDeque<f64>,
    over_since: Option<f64>,
    under_since: Option<f64>,
    ignore_until: f64,
    /// Blocked levels, keyed by the bits of `round(level)`.
    failures: HashMap<u64, Failure>,
}

impl std::fmt::Debug for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Failure {{ count: {}, until: {} }}", self.count, self.until)
    }
}

impl AdaptiveResolution {
    pub fn new(cfg: AdaptiveResolutionConfig) -> Self {
        let cfg = ResolvedConfig::normalize(&cfg);
        AdaptiveResolution {
            current: cfg.max,
            cfg,
            samples: VecDeque::new(),
            over_since: None,
            under_since: None,
            ignore_until: f64::NEG_INFINITY,
            failures: HashMap::new(),
        }
    }

    /// Current ratio (`ratio`).
    pub fn ratio(&self) -> f64 {
        self.current
    }

    /// The resolved config (`config`).
    pub fn config(&self) -> &ResolvedConfig {
        &self.cfg
    }

    /// The ratio levels, highest first: max, max − step, …, down to and including min.
    pub fn levels(&self) -> Vec<f64> {
        let ResolvedConfig { max, min, step, .. } = self.cfg;
        let mut out = Vec::new();
        let mut r = max;
        while r > min + EPS {
            out.push(round(r));
            r = round(r - step);
        }
        out.push(round(min));
        out
    }

    /// Back to `max`, forgetting samples and blocked levels.
    pub fn reset(&mut self) {
        self.reset_patched(None);
    }

    /// Back to `max` of the config with `patch` applied, forgetting samples and blocked levels.
    pub fn reset_with(&mut self, patch: &AdaptiveResolutionPatch) {
        self.reset_patched(Some(patch));
    }

    fn reset_patched(&mut self, patch: Option<&AdaptiveResolutionPatch>) {
        if let Some(p) = patch {
            self.cfg = ResolvedConfig::normalize(&self.cfg.merged(p));
        }
        self.current = self.cfg.max;
        self.failures.clear();
        self.clear_stats();
        self.ignore_until = f64::NEG_INFINITY;
    }

    /// Forget the samples and timers (e.g. another card), keeping the ratio and blocked levels.
    pub fn clear_stats(&mut self) {
        self.samples.clear();
        self.over_since = None;
        self.under_since = None;
    }

    /// Feed one frame's cost (ms) observed at `now` (seconds, monotonic). Returns the change when the
    /// ratio changed, else `None`.
    pub fn sample(&mut self, ms: f64, now: f64) -> Option<AdaptiveResolutionChange> {
        if !ms.is_finite() || ms < 0.0 || !now.is_finite() {
            return None;
        }
        if now < self.ignore_until {
            return None;
        }
        let c = self.cfg;
        self.samples.push_back(ms);
        if self.samples.len() > c.window {
            self.samples.pop_front();
        }
        if self.samples.len() < c.window.min(8) {
            return None;
        }
        let med = median(&self.samples);

        if med > c.budget_ms {
            self.under_since = None;
            let over = *self.over_since.get_or_insert(now);
            if now - over >= c.down_after && self.current > c.min + EPS {
                let levels = self.levels();
                let last = levels.len() - 1;
                let i = self.level_index(&levels);
                let one_step = levels[last.min((i + 1).max(0) as usize)];
                let mut next = one_step;
                if c.predictive {
                    let want = self.current * ((0.9 * c.budget_ms) / med).sqrt();
                    next = levels.iter().copied().find(|&l| l <= want + EPS).unwrap_or(levels[last]);
                    next = next.min(one_step);
                }
                self.block(self.current, now);
                return self.change(next, Direction::Down, med, now);
            }
            return None;
        }
        self.over_since = None;

        if self.current < c.max - EPS {
            let levels = self.levels();
            let i = self.level_index(&levels);
            let next = levels[(i - 1).max(0) as usize];
            let expected = if c.predictive { med * (next / self.current).powi(2) } else { med };
            if expected <= c.budget_ms * c.up_headroom && !self.blocked(next, now) {
                let under = *self.under_since.get_or_insert(now);
                if now - under >= c.up_after {
                    return self.change(next, Direction::Up, med, now);
                }
                return None;
            }
        }
        self.under_since = None;
        None
    }

    /// `levels.findIndex((l) => l <= this.current + EPS)`, -1 when none.
    fn level_index(&self, levels: &[f64]) -> isize {
        levels.iter().position(|&l| l <= self.current + EPS).map_or(-1, |i| i as isize)
    }

    fn change(&mut self, ratio: f64, direction: Direction, frame_ms: f64, now: f64) -> Option<AdaptiveResolutionChange> {
        let previous = self.current;
        if (ratio - previous).abs() < EPS {
            return None;
        }
        self.current = ratio;
        self.clear_stats();
        self.ignore_until = now + self.cfg.settle;
        Some(AdaptiveResolutionChange { ratio, previous, direction, frame_ms })
    }

    /// The level we leave downwards failed: block it, longer each time.
    fn block(&mut self, level: f64, now: f64) {
        let (max_retries, retry_after) = (self.cfg.max_retries, self.cfg.retry_after);
        let f = self.failures.entry(round(level).to_bits()).or_insert(Failure { count: 0, until: 0.0 });
        f.count += 1;
        f.until = if f.count >= max_retries { f64::INFINITY } else { now + retry_after * 2f64.powi(f.count as i32 - 1) };
    }

    fn blocked(&self, level: f64, now: f64) -> bool {
        self.failures.get(&round(level).to_bits()).is_some_and(|f| now < f.until)
    }
}

/// `Math.round(x * 1e4) / 1e4`, with JavaScript's rounding of halves towards +∞.
fn round(x: f64) -> f64 {
    let y = x * 1e4;
    let r = y.floor();
    (if y - r >= 0.5 { r + 1.0 } else { r }) / 1e4
}

/// The median; NaN for no samples (as in the TypeScript).
fn median(a: &VecDeque<f64>) -> f64 {
    let mut s: Vec<f64> = a.iter().copied().collect();
    s.sort_by(f64::total_cmp);
    let m = s.len() >> 1;
    if s.is_empty() {
        f64::NAN
    } else if s.len() % 2 == 1 {
        s[m]
    } else {
        (s[m - 1] + s[m]) / 2.0
    }
}
