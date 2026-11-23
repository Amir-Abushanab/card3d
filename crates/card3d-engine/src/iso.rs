//! The card standards the public card follows (`geometry/iso.ts`): millimetres on the front of a
//! landscape ID-1 card from its left and top edges, and the mapping onto card units.

use crate::geometry::CARD_W;
use crate::layout::{CardFrame, Rect, CARD_H, ID1_BODY_NATIVE};

pub const ID1_WIDTH_MM: f64 = 85.6;
pub const ID1_HEIGHT_MM: f64 = 53.98;
/// Millimetres per card unit.
pub const MM_PER_UNIT: f64 = ID1_WIDTH_MM / CARD_W;

/// An axis-aligned rectangle in mm: x from the left edge, y from the top edge (y grows downwards).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MmRect {
    pub x0: f64,
    pub x1: f64,
    pub y0: f64,
    pub y1: f64,
}

const fn rect(x0: f64, x1: f64, y0: f64, y1: f64) -> MmRect {
    MmRect { x0, x1, y0, y1 }
}

const COLS: [(f64, f64); 2] = [(10.25, 12.25), (17.87, 19.87)];
const ROWS: [(f64, f64); 4] = [(19.23, 20.93), (21.77, 23.47), (24.31, 26.01), (26.85, 28.55)];

/// ISO/IEC 7816-2 contact zones C1–C8 (index 0 = C1): C1–C4 down the left column, C5–C8 the right.
pub fn contacts() -> [MmRect; 8] {
    std::array::from_fn(|i| {
        let (c, r) = (i / 4, i % 4);
        rect(COLS[c].0, COLS[c].1, ROWS[r].0, ROWS[r].1)
    })
}

/// The rectangle every contact zone lies in.
pub const CONTACT_AREA: MmRect = rect(10.25, 19.87, 19.23, 28.55);

/// The public chip's contact plate (`ISO_CHIP_PLATE`), mm.
pub struct ChipPlate {
    pub width: f64,
    pub height: f64,
    pub corner_radius: f64,
    pub gap: f64,
    /// Centre pad: clearance from each contact column, and its top / bottom edges (mm from the top edge).
    pub centre_side: f64,
    pub centre_top: f64,
    pub centre_bottom: f64,
    /// How far the plate's top lies above the face, mm.
    pub protrusion: f64,
}

pub const CHIP_PLATE: ChipPlate =
    ChipPlate { width: 12.6, height: 11.4, corner_radius: 1.5, gap: 0.15, centre_side: 0.55, centre_top: 20.35, centre_bottom: 27.43, protrusion: 0.05 };

/// The plate centre on the card, mm: the centre of the contact area.
pub const CHIP_CENTRE_MM: (f64, f64) = ((CONTACT_AREA.x0 + CONTACT_AREA.x1) / 2.0, (CONTACT_AREA.y0 + CONTACT_AREA.y1) / 2.0);

/// The plate outline, mm.
pub fn chip_plate_mm() -> MmRect {
    let (cx, cy) = CHIP_CENTRE_MM;
    rect(cx - CHIP_PLATE.width / 2.0, cx + CHIP_PLATE.width / 2.0, cy - CHIP_PLATE.height / 2.0, cy + CHIP_PLATE.height / 2.0)
}

/// One conductive pad: its contact (C1–C8, or 0 for the centre pad) and its pieces.
pub struct ChipPad {
    pub contact: u32,
    pub rects: Vec<MmRect>,
}

/// `isoChipPads`: C1–C8 cover their zones; the centre pad sits between the columns, the top and
/// bottom pads reach over it, split down the middle.
pub fn chip_pads() -> Vec<ChipPad> {
    let p = chip_plate_mm();
    let c = &CHIP_PLATE;
    let k = contacts();
    let left = k[0].x1 + c.centre_side;
    let right = k[4].x0 - c.centre_side;
    let mid = CHIP_CENTRE_MM.0;
    let sep = [p.y0, (ROWS[0].1 + ROWS[1].0) / 2.0, (ROWS[1].1 + ROWS[2].0) / 2.0, (ROWS[2].1 + ROWS[3].0) / 2.0, p.y1];
    let mut pads = Vec::new();
    for side in 0..2 {
        let (ox0, ox1) = if side == 0 { (p.x0, left) } else { (right, p.x1) };
        let (sx0, sx1) = if side == 0 { (left, mid) } else { (mid, right) };
        for r in 0..4 {
            let mut rects = vec![rect(ox0, ox1, sep[r], sep[r + 1])];
            if r == 0 {
                rects.push(rect(sx0, sx1, p.y0, c.centre_top));
            }
            if r == 3 {
                rects.push(rect(sx0, sx1, c.centre_bottom, p.y1));
            }
            pads.push(ChipPad { contact: (side * 4 + r + 1) as u32, rects });
        }
    }
    pads.push(ChipPad { contact: 0, rects: vec![rect(left, right, c.centre_top, c.centre_bottom)] });
    pads
}

/// A point in mm on the landscape card as card units (centred; y up). Portrait: turned a quarter turn.
pub fn point(x_mm: f64, y_mm: f64, portrait: bool) -> (f64, f64) {
    let x = (x_mm - ID1_WIDTH_MM / 2.0) / MM_PER_UNIT;
    let y = (ID1_HEIGHT_MM / 2.0 - y_mm) / MM_PER_UNIT;
    if portrait {
        (y, -x)
    } else {
        (x, y)
    }
}

/// The chip in a frame: plate centre, turn, size and height above the face, card units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChipPlacement {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub width: f64,
    pub height: f64,
    pub top: f64,
}

pub fn chip_placement(portrait: bool) -> ChipPlacement {
    let (x, y) = point(CHIP_CENTRE_MM.0, CHIP_CENTRE_MM.1, portrait);
    ChipPlacement {
        x,
        y,
        rotation: if portrait { -std::f64::consts::FRAC_PI_2 } else { 0.0 },
        width: CHIP_PLATE.width / MM_PER_UNIT,
        height: CHIP_PLATE.height / MM_PER_UNIT,
        top: CHIP_PLATE.protrusion / MM_PER_UNIT,
    }
}

/// ISO/IEC 7811-1 embossing areas as rectangles, mm from the left / top edges of a landscape card (the
/// standard measures from the bottom edge). Area 1 is the identification number line (character
/// centreline 21.42 above the bottom edge, 19 characters at 3.63 pitch from 10.18 mm); area 2 is name
/// and address (four lines of 27 characters at 2.54 pitch, first centreline 7.65 mm from the left).
/// Each rectangle runs from half a pitch before the first character to half a pitch after the last.
pub struct Iso7811Areas {
    pub number: MmRect,
    pub name: MmRect,
}

pub const ISO_7811_AREAS: Iso7811Areas = Iso7811Areas {
    number: rect(10.18 - 3.63 / 2.0, 10.18 + 65.31 + 3.63 / 2.0, ID1_HEIGHT_MM - 24.03, ID1_HEIGHT_MM - (24.03 - 4.32)),
    name: rect(7.65 - 2.54 / 2.0, 7.65 + 66.04 + 2.54 / 2.0, ID1_HEIGHT_MM - 14.53, ID1_HEIGHT_MM - 2.54),
};
/// Area 1's character centreline, mm from the top edge (21.42 above the bottom edge).
pub const ISO_NUMBER_CENTRELINE_MM: f64 = ID1_HEIGHT_MM - 21.42;

/// An mm rectangle as a centred card-unit rectangle in a landscape or portrait frame (`isoRect`).
pub fn iso_rect(r: &MmRect, portrait: bool) -> Rect {
    let (x, y) = point((r.x0 + r.x1) / 2.0, (r.y0 + r.y1) / 2.0, portrait);
    let w = (r.x1 - r.x0) / MM_PER_UNIT;
    let h = (r.y1 - r.y0) / MM_PER_UNIT;
    if portrait {
        Rect { x, y, w: h, h: w }
    } else {
        Rect { x, y, w, h }
    }
}

/// Native body units per card unit (the ID-1 body's 860 native units are `CARD_W`).
const NATIVE_PER_UNIT: f64 = ID1_BODY_NATIVE.width / CARD_W;

/// The frame of an ID-1 card body: print area, body, corner radius (card units), the ISO chip and the
/// cutouts (`isoFrame`).
pub fn iso_frame(portrait: bool, corner_radius: f64, cutouts: &[String]) -> CardFrame {
    let nw = if portrait { ID1_BODY_NATIVE.height } else { ID1_BODY_NATIVE.width };
    let nh = if portrait { ID1_BODY_NATIVE.width } else { ID1_BODY_NATIVE.height };
    CardFrame {
        width: if portrait { CARD_H } else { CARD_W },
        height: if portrait { CARD_W } else { CARD_H },
        body_width: nw / NATIVE_PER_UNIT,
        body_height: nh / NATIVE_PER_UNIT,
        portrait,
        corner_radius,
        chip: chip_placement(portrait),
        cutouts: cutouts.to_vec(),
    }
}
