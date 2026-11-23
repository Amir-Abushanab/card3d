//! Pure layout maths of the card's front (`card/branding.ts`, `geometry/shape.ts`, `geometry/constants.ts`):
//! the branding layout, chip / contactless / user-logo rectangles and the extra text lines. Card units,
//! f64, the same operation order as the TypeScript so results match exactly.

use crate::geometry::{BODY_SCALE, ID1_CORNER};
use crate::iso::{self, ISO_7811_AREAS, ISO_NUMBER_CENTRELINE_MM};

// ── constants (geometry/constants.ts) ───────────────────────────────────────

/// Card layout width `W`.
pub const CARD_W: f64 = 3.37;
/// Card layout height `H`.
pub const CARD_H: f64 = 2.125;

/// The public ID-1 body in native units: 860 wide, corner radius 3.18 mm, 2-unit bevel.
pub struct BodyNative {
    pub width: f64,
    pub height: f64,
    pub depth: f64,
    pub corner_radius: f64,
    pub bevel: f64,
}

const NATIVE_W: f64 = 860.0;
const NATIVE_PER_MM: f64 = NATIVE_W / 85.6;

/// The public card body in native units, ISO/IEC 7810 ID-1 (`ID1_BODY_NATIVE`).
pub const ID1_BODY_NATIVE: BodyNative =
    BodyNative { width: NATIVE_W, height: 53.98 * NATIVE_PER_MM, depth: 7.0, corner_radius: 3.18 * NATIVE_PER_MM, bevel: 2.0 };

/// Chip layout as fractions of W/H: left, top, width; aspect = w/h.
pub struct ChipLayout {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub aspect: f64,
}
pub const CHIP_LAYOUT: ChipLayout = ChipLayout { left: 0.75, top: 0.475, width: 0.15, aspect: 140.0 / 120.0 };

/// Chip footprint in card units.
pub struct ChipSize {
    pub width: f64,
    pub height: f64,
}
pub const CHIP_SIZE: ChipSize = ChipSize { width: CHIP_LAYOUT.width * CARD_W, height: (CHIP_LAYOUT.width * CARD_W) / CHIP_LAYOUT.aspect };

/// Chip centre in card-local x/y: (1.09525, -0.1635179).
pub const CHIP_CENTER: (f64, f64) =
    (-CARD_W / 2.0 + CHIP_LAYOUT.left * CARD_W + CHIP_SIZE.width / 2.0, CARD_H / 2.0 - CHIP_LAYOUT.top * CARD_H - CHIP_SIZE.height / 2.0);

/// The contactless mark's size range and default (`CONTACTLESS_SCALE`).
pub struct ContactlessScale {
    pub min: f64,
    pub max: f64,
    pub default: f64,
}
pub const CONTACTLESS_SCALE: ContactlessScale = ContactlessScale { min: 0.4, max: 1.2, default: 0.78 };
/// Width / height of the contactless mark (the traced ink box, 107 x 134).
pub const CONTACTLESS_ASPECT: f64 = 107.0 / 134.0;

/// Branding layer (`LAYER.branding.z`): logo / name / bio, J + 0.003 + 0.01.
pub const LAYER_BRANDING_Z: f64 = 0.003 + 0.01;

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    hi.min(lo.max(x))
}

// ── frame ───────────────────────────────────────────────────────────────────

/// Layout of an ID-1 card body with the standards' layout (card units): `CardFrame`.
#[derive(Clone, Debug, PartialEq)]
pub struct CardFrame {
    /// Print area: 3.37 x 2.125, or 2.125 x 3.37 portrait.
    pub width: f64,
    pub height: f64,
    /// Physical body outline.
    pub body_width: f64,
    pub body_height: f64,
    pub portrait: bool,
    /// Outer corner radius.
    pub corner_radius: f64,
    /// The chip plate: centre, turn about z, size before the turn, height above the face.
    pub chip: iso::ChipPlacement,
    pub cutouts: Vec<String>,
}

/// The frame of the public ID-1 card: `isoFrame(false, ID1_BODY_NATIVE.cornerRadius * BODY_SCALE, [])`.
pub fn public_frame() -> CardFrame {
    iso::iso_frame(false, ID1_CORNER * BODY_SCALE, &[])
}

/// How far a corner block must move in diagonally (the same distance in from the side and from the
/// top/bottom edge) so that its outer corner, `dx` in from the side and `dy` in from the top or
/// bottom, lies inside the rounded corner with `pad` to spare. 0 when already clear, or no frame.
pub fn corner_inset(frame: Option<&CardFrame>, dx: f64, dy: f64, pad: f64) -> f64 {
    let Some(frame) = frame else { return 0.0 };
    let r = frame.corner_radius;
    let a = r - dx;
    let b = r - dy;
    if a <= 0.0 || b <= 0.0 {
        return 0.0;
    }
    let rr = 0.0_f64.max(r - pad);
    if a * a + b * b <= rr * rr {
        return 0.0;
    }
    // (a - u)^2 + (b - u)^2 = R^2  ->  the smaller root.
    let disc = 2.0 * rr * rr - (a - b) * (a - b);
    if disc >= 0.0 {
        (a + b - disc.sqrt()) / 2.0
    } else {
        a.max(b) - rr
    }
}

/// `cornerInset`'s default clearance.
pub const CORNER_INSET_PAD: f64 = 0.04;

// ── branding layout ─────────────────────────────────────────────────────────

/// Branding layout inputs, fractions of W or H.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrontLayout {
    pub logo_left: f64,
    pub logo_top: f64,
    pub logo_height: f64,
    pub name_font_height: f64,
    pub name_bottom: f64,
}

pub const DEFAULT_FRONT_LAYOUT: FrontLayout = FrontLayout { logo_left: 0.06, logo_top: 0.075, logo_height: 0.1, name_font_height: 0.05, name_bottom: 0.09 };

impl Default for FrontLayout {
    fn default() -> Self {
        DEFAULT_FRONT_LAYOUT
    }
}

/// `Partial<FrontLayout>`: fields left `None` take the default.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrontLayoutOverride {
    pub logo_left: Option<f64>,
    pub logo_top: Option<f64>,
    pub logo_height: Option<f64>,
    pub name_font_height: Option<f64>,
    pub name_bottom: Option<f64>,
}

impl FrontLayoutOverride {
    fn resolve(&self) -> FrontLayout {
        let d = DEFAULT_FRONT_LAYOUT;
        FrontLayout {
            logo_left: self.logo_left.unwrap_or(d.logo_left),
            logo_top: self.logo_top.unwrap_or(d.logo_top),
            logo_height: self.logo_height.unwrap_or(d.logo_height),
            name_font_height: self.name_font_height.unwrap_or(d.name_font_height),
            name_bottom: self.name_bottom.unwrap_or(d.name_bottom),
        }
    }
}

/// Logo raster size and plane aspect (256 x 224 => 56/49).
pub struct LogoCanvas {
    pub width: f64,
    pub height: f64,
}
pub const LOGO_CANVAS: LogoCanvas = LogoCanvas { width: 256.0, height: 224.0 };

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogoBox {
    pub width: f64,
    pub height: f64,
    pub left: f64,
    pub top: f64,
}

/// Area 1's number line (card units): left and right ends and the characters' centreline `y`, +-`h` / 2.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NumberLine {
    pub left: f64,
    pub right: f64,
    pub y: f64,
    pub h: f64,
}

/// Derived branding layout (TS names: E, M, T, I.
#[derive(Clone, Debug, PartialEq)]
pub struct BrandingLayout {
    /// World height of one text line box (`E`).
    pub e: f64,
    /// Side margin (`M`).
    pub m: f64,
    /// maxWidthLines / maxHeightLines for the rasteriser (`T`, `I`).
    pub t: f64,
    pub i: f64,
    pub logo: LogoBox,
    pub text_bottom: f64,
    /// Branding plane |z|: J + 0.013.
    pub z: f64,
    /// Shaped card (`geometry.frame`): print size, chip, corner insets. Absent on the standard card.
    pub frame: Option<CardFrame>,
    /// Left edge of the name block (= `logo.left` on the standard card).
    pub name_left: Option<f64>,
    /// Right edge of the bio / right-hand text (= W/2 - M on the standard card).
    pub text_right: Option<f64>,
    /// Shaped card: how far the top corner blocks moved in (diagonally) to clear the corner radius.
    pub corner_top: Option<f64>,
    /// Landscape ID-1 frame: ISO/IEC 7811-1 embossing area 1, the number line. The first bottom-left
    /// text line goes here.
    pub number_line: Option<NumberLine>,
}

pub fn branding_layout(layout: &FrontLayoutOverride, body_depth: f64, frame: Option<&CardFrame>) -> BrandingLayout {
    let l = layout.resolve();
    if let Some(frame) = frame {
        return shaped_branding_layout(&l, body_depth, frame);
    }
    let c = |v: f64| clamp(v, 0.0, 0.45);
    let e = CARD_H * l.name_font_height;
    let m = CARD_W * c(l.logo_left);
    let lh = CARD_H * l.logo_height;
    BrandingLayout {
        e,
        m,
        t: (CARD_W - 2.0 * m) / e,
        i: (CARD_H - CARD_H * c(l.name_bottom) - CARD_H * c(l.logo_top)) / e,
        logo: LogoBox {
            width: (LOGO_CANVAS.width / LOGO_CANVAS.height) * lh,
            height: lh,
            left: -CARD_W / 2.0 + CARD_W * l.logo_left,
            top: CARD_H / 2.0 - CARD_H * l.logo_top,
        },
        text_bottom: -CARD_H / 2.0 + CARD_H * l.name_bottom,
        z: body_depth / 2.0 + LAYER_BRANDING_Z,
        frame: None,
        name_left: None,
        text_right: None,
        corner_top: None,
        number_line: None,
    }
}

/// The layout of an ID-1 frame (the public card and every shape): the standard layout's absolute
/// sizes measured from the frame's edges, every corner block moved in just enough to clear the corner
/// radius. Landscape, the name and number lines follow ISO/IEC 7811-1's embossing areas: the name
/// starts where area 2 starts and keeps within it, area 1 takes the number line. Portrait cards
/// aren't embossed: their print keeps the margins.
fn shaped_branding_layout(l: &FrontLayout, body_depth: f64, frame: &CardFrame) -> BrandingLayout {
    let c = |v: f64| clamp(v, 0.0, 0.45);
    let w = frame.width;
    let h = frame.height;
    let e = CARD_H * l.name_font_height;
    let m = CARD_W * c(l.logo_left);
    let lh = CARD_H * l.logo_height;
    let top = CARD_H * c(l.logo_top);
    let mut bottom = CARD_H * c(l.name_bottom);
    // Corner blocks (mark, name, bio) move in diagonally just enough to clear the corner radius.
    let inset_top = corner_inset(Some(frame), m, top, CORNER_INSET_PAD);
    let mut inset_bottom = corner_inset(Some(frame), m, bottom, CORNER_INSET_PAD);
    let mut name_left = -w / 2.0 + m + inset_bottom;
    let mut name_right = w / 2.0 - m - inset_bottom;
    let mut number_line = None;
    if !frame.portrait {
        let name = iso::iso_rect(&ISO_7811_AREAS.name, false);
        let num = iso::iso_rect(&ISO_7811_AREAS.number, false);
        // The name's line box (about 1.13 E with the raster's padding) between area 2's bottom and top.
        let lo = name.y - name.h / 2.0 + h / 2.0;
        bottom = clamp(bottom, lo, lo.max(lo + name.h - 1.13 * e));
        inset_bottom = corner_inset(Some(frame), m, bottom, CORNER_INSET_PAD);
        name_left = name_left.max(name.x - name.w / 2.0);
        name_right = name_right.min(name.x + name.w / 2.0);
        number_line = Some(NumberLine {
            left: num.x - num.w / 2.0,
            right: (num.x + num.w / 2.0).min(w / 2.0 - m),
            y: iso::point(0.0, ISO_NUMBER_CENTRELINE_MM, false).1,
            h: num.h,
        });
    }
    BrandingLayout {
        e,
        m,
        t: (name_right - name_left) / e,
        i: (h - bottom - top - inset_top - inset_bottom) / e,
        logo: LogoBox { width: (LOGO_CANVAS.width / LOGO_CANVAS.height) * lh, height: lh, left: -w / 2.0 + m + inset_top, top: h / 2.0 - top - inset_top },
        text_bottom: -h / 2.0 + bottom + inset_bottom,
        z: body_depth / 2.0 + LAYER_BRANDING_Z,
        frame: Some(frame.clone()),
        name_left: Some(name_left),
        text_right: Some(w / 2.0 - m - inset_bottom),
        corner_top: Some(inset_top),
        number_line,
    }
}

// ── rectangles ──────────────────────────────────────────────────────────────

/// A centred rectangle, card units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The default card's chip (no frame): at `CHIP_CENTER`, unturned, its top
/// `LAYER.chip.top` (0.006) above the face.
pub fn default_chip() -> iso::ChipPlacement {
    iso::ChipPlacement { x: CHIP_CENTER.0, y: CHIP_CENTER.1, rotation: 0.0, width: CHIP_SIZE.width, height: CHIP_SIZE.height, top: 0.006 }
}

/// Where the chip sits (centre and size as drawn), for layout.
pub fn chip_rect(frame: Option<&CardFrame>) -> Rect {
    let c = frame.map_or_else(default_chip, |f| f.chip);
    let turned = c.rotation.sin().abs() > 0.5;
    Rect { x: c.x, y: c.y, w: if turned { c.height } else { c.width }, h: if turned { c.width } else { c.height } }
}

/// The contactless mark: beside the chip, centred on it, as tall as `scale` x the chip, 0.07 (1.8 mm)
/// from it. The standard (frame-less) card puts it left of its right-hand chip; an ID-1 frame's chip has it on its
/// right and (landscape) stays out of embossing area 1 below it, so at most about the plate's height.
pub fn contactless_rect(frame: Option<&CardFrame>, scale: f64) -> Rect {
    let chip = chip_rect(frame);
    let mut h = chip.h * clamp(scale, CONTACTLESS_SCALE.min, CONTACTLESS_SCALE.max);
    // Landscape ID-1: centred on the chip, it stops short of embossing area 1 (the number line) below.
    if let Some(f) = frame {
        if !f.portrait {
            h = h.min(2.0 * (chip.y - iso::point(0.0, ISO_7811_AREAS.number.y0 - 0.3, false).1));
        }
    }
    let w = h * CONTACTLESS_ASPECT;
    let gap = 0.07;
    let left = frame.is_none() && chip.x > 0.0;
    let x = if left { chip.x - chip.w / 2.0 - gap - w / 2.0 } else { chip.x + chip.w / 2.0 + gap + w / 2.0 };
    Rect { x, y: chip.y, w, h }
}

// ── user logos ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogoPosition {
    Corner,
    TopRight,
    Center,
    BottomRight,
}

impl LogoPosition {
    /// "corner" | "top-right" | "center" | "bottom-right".
    pub fn parse(s: &str) -> Option<Self> {
        LOGO_POSITIONS.iter().copied().find(|p| p.as_str() == s)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Corner => "corner",
            Self::TopRight => "top-right",
            Self::Center => "center",
            Self::BottomRight => "bottom-right",
        }
    }
}

pub const LOGO_POSITIONS: [LogoPosition; 4] = [LogoPosition::Corner, LogoPosition::TopRight, LogoPosition::Center, LogoPosition::BottomRight];

pub struct LogoScaleRange {
    pub min: f64,
    pub max: f64,
}
pub const LOGO_SCALE_RANGE: LogoScaleRange = LogoScaleRange { min: 0.4, max: 3.0 };

/// The parts of a `CardLogo` that place it: absent position => corner, absent / non-finite scale => 1.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LogoPlacement {
    pub position: Option<LogoPosition>,
    pub scale: Option<f64>,
}

/// World-space rectangle (centre x/y, size w/h) of a user logo on the front face. Sizes start from
/// the corner mark's height x `scale`, then shrink to stay clear of the chip and the name line.
/// `obstacles` defaults (in TS) to the chip when the layout has a frame: pass `None` for that.
pub fn user_logo_rect(logo: &LogoPlacement, aspect: f64, l: &BrandingLayout, obstacles: Option<&[Rect]>) -> Rect {
    let default_obstacles;
    let obstacles: &[Rect] = match obstacles {
        Some(o) => o,
        None => {
            default_obstacles = if l.frame.is_some() { vec![chip_rect(l.frame.as_ref())] } else { Vec::new() };
            &default_obstacles
        }
    };
    let position = logo.position.unwrap_or(LogoPosition::Corner);
    let scale = clamp(logo.scale.filter(|s| s.is_finite()).unwrap_or(1.0), LOGO_SCALE_RANGE.min, LOGO_SCALE_RANGE.max);
    // Top band (above the chip, which starts 0.475 H down) and the bottom-right corner (below it).
    let (mut lim_w, mut lim_h) = match position {
        LogoPosition::Corner => (0.6 * CARD_W, 0.36 * CARD_H),
        LogoPosition::TopRight => (0.5 * CARD_W, 0.36 * CARD_H),
        LogoPosition::Center => (0.46 * CARD_W, 0.5 * CARD_H),
        LogoPosition::BottomRight => (0.42 * CARD_W, 0.2 * CARD_H),
    };
    let mut h = l.logo.height * scale;
    let mut w = h * aspect;
    let f = l.frame.as_ref();
    if let Some(f) = f {
        // Shaped card: the same physical limits, never wider than the print area between the margins.
        lim_w = lim_w.min(f.width - 2.0 * (l.m + l.corner_top.unwrap_or(0.0)));
        lim_h = lim_h.min(if f.portrait { 0.3 * f.height } else { lim_h });
    }
    let k = 1.0_f64.min(lim_w / w).min(lim_h / h);
    w *= k;
    h *= k;
    let left = l.logo.left;
    let right = -left;
    // Shaped cards: the right-hand corners clear the corner radius at their own heights.
    let right_top = f.map_or(right, |f| f.width / 2.0 - l.m - l.corner_top.unwrap_or(0.0));
    let right_bottom = if f.is_some() { l.text_right.unwrap_or(right) } else { right };
    let top = l.logo.top;
    let place = |w: f64, h: f64| -> Rect {
        match position {
            LogoPosition::TopRight => Rect { x: right_top - w / 2.0, y: top - h / 2.0, w, h },
            LogoPosition::Center => Rect { x: 0.0, y: 0.0, w, h },
            LogoPosition::BottomRight => Rect { x: right_bottom - w / 2.0, y: l.text_bottom + h / 2.0, w, h },
            LogoPosition::Corner => Rect { x: left + w / 2.0, y: top - h / 2.0, w, h },
        }
    };
    // An ID-1 frame's chip (and contactless mark) can sit where a large logo reaches: shrink it, about
    // its anchor, until it clears them by 0.06.
    let pad = 0.06;
    let hits = |r: &Rect| obstacles.iter().any(|b| (r.x - b.x).abs() < (r.w + b.w) / 2.0 + pad && (r.y - b.y).abs() < (r.h + b.h) / 2.0 + pad);
    if !hits(&place(w, h)) {
        return place(w, h);
    }
    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..24 {
        let m = (lo + hi) / 2.0;
        if hits(&place(w * m, h * m)) {
            hi = m;
        } else {
            lo = m;
        }
    }
    place(w * lo, h * lo)
}

// ── text lines ──────────────────────────────────────────────────────────────

/// Size of the bio on a clear card's front, x the name's line box (like an extra text line).
pub const CLEAR_BIO_SIZE: f64 = 0.8;
pub const DEFAULT_LINE_SIZE: f64 = 0.8;
/// Where a text raster's capitals are centred, as a fraction of its box from the top: 6 px padding
/// plus half the ascent of "H" (about 0.78 of the 'Hg' line height) over the line height plus 12 px.
pub const NUMBER_CAP_CENTRE: f64 = (6.0 + 0.39 * 94.0) / (94.0 + 12.0);

pub struct TextLineLimits {
    pub size: (f64, f64),
    pub tracking: (f64, f64),
    pub max_lines: usize,
    pub max_chars: usize,
}
pub const TEXT_LINE_LIMITS: TextLineLimits = TextLineLimits { size: (0.4, 2.0), tracking: (-0.05, 0.6), max_lines: 3, max_chars: 48 };

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

impl Align {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "left" => Some(Self::Left),
            "center" => Some(Self::Center),
            "right" => Some(Self::Right),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement {
    BottomLeft,
    BottomRight,
    Center,
    Top,
}

impl Placement {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "bottom-left" => Some(Self::BottomLeft),
            "bottom-right" => Some(Self::BottomRight),
            "center" => Some(Self::Center),
            "top" => Some(Self::Top),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineBox {
    /// Raster aspect (w/h) and height in name line boxes (as `CardTextRaster`).
    pub aspect: f64,
    pub height_in_line_boxes: f64,
    pub size: Option<f64>,
    pub align: Option<Align>,
    pub placement: Option<Placement>,
    /// Never the number line (the clear card's bio, which belongs with the name).
    pub with_name: bool,
}

/// Where each extra text line goes. Lines sharing a placement stack in reading order: bottom-left
/// directly above the name (`name_top`), bottom-right up from the name's baseline band, centre around
/// the middle, top down from the mark's top. They're aligned in their column (default: left, right,
/// centre, right) and kept clear of the chip, the contactless mark and (top) the logo; an over-long
/// line shrinks to fit its column. With an ISO number line (`l.number_line`) the first bottom-left
/// line goes on it, its characters centred on the area's centreline, the rest stack above the name.
pub fn layout_text_lines(lines: &[LineBox], l: &BrandingLayout, name_top: f64, obstacles: &[Rect]) -> Vec<Rect> {
    let f = l.frame.as_ref();
    let w = f.map_or(CARD_W, |f| f.width);
    let left0 = l.name_left.unwrap_or(l.logo.left);
    let right0 = l.text_right.unwrap_or(w / 2.0 - l.m);
    let gap = 0.22 * l.e;
    let mut out = vec![Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }; lines.len()];
    // Groups in order of first appearance; `None` is the number line.
    let mut groups: Vec<(Option<Placement>, Vec<usize>)> = Vec::new();
    let number_at = if l.number_line.is_some() {
        lines.iter().position(|ln| ln.placement.unwrap_or(Placement::BottomLeft) == Placement::BottomLeft && !ln.with_name)
    } else {
        None
    };
    for (i, ln) in lines.iter().enumerate() {
        let p = if Some(i) == number_at { None } else { Some(ln.placement.unwrap_or(Placement::BottomLeft)) };
        match groups.iter_mut().find(|g| g.0 == p) {
            Some(g) => g.1.push(i),
            None => groups.push((p, vec![i])),
        }
    }
    for (placement, idx) in &groups {
        let heights: Vec<f64> = idx
            .iter()
            .map(|&i| l.e * clamp(lines[i].size.unwrap_or(DEFAULT_LINE_SIZE), TEXT_LINE_LIMITS.size.0, TEXT_LINE_LIMITS.size.1) * lines[i].height_in_line_boxes)
            .collect();
        let total = heights.iter().fold(0.0, |a, b| a + b) + gap * (heights.len() as f64 - 1.0);
        // Block's vertical extent, then the y of each line (reading order = top to bottom).
        let num = if placement.is_none() { l.number_line } else { None };
        // The number line: the capitals (about 0.4 of the raster box down from its top) on the centreline.
        let top = if let Some(n) = &num {
            n.y + total * NUMBER_CAP_CENTRE
        } else {
            match placement {
                Some(Placement::BottomLeft) => name_top + gap + total,
                Some(Placement::BottomRight) => l.text_bottom + total,
                Some(Placement::Center) => total / 2.0,
                _ => l.logo.top,
            }
        };
        let bottom = top - total;
        // Column: between the margins, clear of whatever overlaps the block vertically.
        let is_top = *placement == Some(Placement::Top);
        let mut left = match (&num, f) {
            (Some(n), _) => n.left,
            (None, Some(_)) if is_top => -w / 2.0 + l.m + l.corner_top.unwrap_or(0.0),
            _ => left0,
        };
        let mut right = match (&num, f) {
            (Some(n), _) => n.right,
            (None, Some(_)) if is_top => w / 2.0 - l.m - l.corner_top.unwrap_or(0.0),
            _ => right0,
        };
        let centre = (left + right) / 2.0;
        for ob in obstacles {
            if ob.y - ob.h / 2.0 > top || ob.y + ob.h / 2.0 < bottom {
                continue;
            }
            if ob.x - ob.w / 2.0 > right || ob.x + ob.w / 2.0 < left {
                continue;
            }
            if ob.x >= centre {
                right = right.min(ob.x - ob.w / 2.0 - 0.08);
            } else {
                left = left.max(ob.x + ob.w / 2.0 + 0.08);
            }
        }
        let col_w = 0.2_f64.max(right - left);
        let mut y = top;
        for (k, &i) in idx.iter().enumerate() {
            let ln = &lines[i];
            let mut h = heights[k];
            let mut w = h * ln.aspect;
            let fit = 1.0_f64.min(col_w / w);
            let yc = y - h / 2.0;
            y -= h + gap;
            w *= fit;
            h *= fit;
            let align = ln.align.unwrap_or(if *placement == Some(Placement::BottomLeft) || num.is_some() {
                Align::Left
            } else if *placement == Some(Placement::Center) {
                Align::Center
            } else {
                Align::Right
            });
            let x = match align {
                Align::Left => left + w / 2.0,
                Align::Right => right - w / 2.0,
                Align::Center => (left + right) / 2.0,
            };
            out[i] = Rect { x, y: yc, w, h };
        }
    }
    out
}
