//! Text for the native canvas: the six card fonts (SIL OFL 1.1, licences beside them in assets/)
//! through ab_glyph, as bold 700 faces in two subsets (Latin, Latin-Ext), chosen per character like
//! the browser's `unicode-range` faces. They are the web package's own WOFF2 files
//! (packages/core/assets/fonts), decoded once on first use, so native and web ship the same font files;
//! a variable face (Inter) is set to the weight asked (`wght` 700). Pair kerning comes from each face's GPOS `kern` feature, as
//! browsers apply it (ab_glyph alone reads only the legacy `kern` table, which these fonts lack).
//! An unknown family draws with Inter (the canvas's fallback in the TypeScript engine is Arial).

use ab_glyph::{point, Font, FontRef, GlyphId, PxScale, ScaleFont, VariableFont};

/// The catalog (`CARD_FONTS` in packages/core/src/fonts.ts): family → (Latin, Latin-Ext) faces, as the
/// web package's WOFF2 files.
macro_rules! web_font {
    ($name:literal) => {
        include_bytes!(concat!("../../../packages/core/assets/fonts/", $name, "-normal.woff2"))
    };
}
const WEB_FACES: [(&str, &[u8], &[u8]); 6] = [
    ("card3d Inter", web_font!("inter-latin-wght"), web_font!("inter-latin-ext-wght")),
    ("card3d Manrope", web_font!("manrope-latin-700"), web_font!("manrope-latin-ext-700")),
    ("card3d Space Grotesk", web_font!("space-grotesk-latin-700"), web_font!("space-grotesk-latin-ext-700")),
    ("card3d Unbounded", web_font!("unbounded-latin-700"), web_font!("unbounded-latin-ext-700")),
    ("card3d Playfair Display", web_font!("playfair-display-latin-700"), web_font!("playfair-display-latin-ext-700")),
    ("card3d IBM Plex Mono", web_font!("ibm-plex-mono-latin-700"), web_font!("ibm-plex-mono-latin-ext-700")),
];

/// A family and its (Latin, Latin-Ext) faces as TrueType / OpenType.
type CatalogFace = (&'static str, &'static [u8], &'static [u8]);

/// The catalog's faces decoded to TrueType / OpenType (`sfnt`), once.
fn catalog() -> &'static [CatalogFace] {
    static DECODED: std::sync::OnceLock<Vec<CatalogFace>> = std::sync::OnceLock::new();
    DECODED.get_or_init(|| {
        let decode = |woff2: &[u8]| -> &'static [u8] { Box::leak(sfnt(woff2.to_vec()).expect("bundled font").into_boxed_slice()) };
        WEB_FACES.iter().map(|(family, latin, ext)| (*family, decode(latin), decode(ext))).collect()
    })
}

/// Faces a host registered at run time (`register`: an asset pack's fonts): family, weight, bytes.
static REGISTERED: std::sync::Mutex<Vec<(String, u16, &'static [u8])>> = std::sync::Mutex::new(Vec::new());

/// Makes a font usable as `family` at `weight` (the host's `font_face`): TrueType / OpenType, or WOFF /
/// WOFF2 (decoded to TrueType / OpenType first, `sfnt`). False when the bytes aren't a font ab_glyph
/// reads.
pub fn register(family: &str, weight: u16, bytes: Vec<u8>) -> bool {
    let Some(bytes) = sfnt(bytes) else { return false };
    if FontRef::try_from_slice(&bytes).is_err() || ttf_parser::Face::parse(&bytes, 0).is_err() {
        return false;
    }
    let mut r = REGISTERED.lock().unwrap();
    if !r.iter().any(|(f, w, _)| f == family && *w == weight) {
        r.push((family.to_string(), weight, Box::leak(bytes.into_boxed_slice())));
    }
    true
}

/// A font file as TrueType / OpenType: WOFF (zlib per table) and WOFF2 (Brotli, with its glyf / loca
/// and hmtx transforms undone) are decoded; anything else is returned as it is. `None` for a WOFF or
/// WOFF2 file that doesn't decode.
pub fn sfnt(bytes: Vec<u8>) -> Option<Vec<u8>> {
    match bytes.get(..4) {
        Some(b"wOFF") => wuff::decompress_woff1(&bytes).ok(),
        Some(b"wOF2") => wuff::decompress_woff2(&bytes).ok(),
        _ => Some(bytes),
    }
}

/// The faces of the first family of a CSS font shorthand (`700 100px "card3d Inter", Arial`) that
/// the catalog or the registered fonts have (a registered family's face nearest the weight asked);
/// Inter otherwise.
fn faces_of(css: &str) -> (Vec<&'static [u8]>, u16) {
    let weight = css.split_whitespace().take_while(|t| !t.ends_with("px")).find_map(|t| t.parse::<u16>().ok()).unwrap_or(400);
    let registered = REGISTERED.lock().unwrap();
    for part in css.split(',') {
        let name = part.trim().rsplit_once("px").map_or(part.trim(), |(_, n)| n.trim()).trim_matches(['"', '\'']).trim();
        if let Some((_, latin, ext)) =
            catalog().iter().find(|(f, _, _)| f.eq_ignore_ascii_case(name) || f.strip_prefix("card3d ").is_some_and(|s| s.eq_ignore_ascii_case(name)))
        {
            return (vec![*latin, *ext], 700);
        }
        if let Some((_, _, bytes)) = registered.iter().filter(|(f, _, _)| f.eq_ignore_ascii_case(name)).min_by_key(|(_, w, _)| w.abs_diff(weight)) {
            return (vec![*bytes], weight);
        }
    }
    (vec![catalog()[0].1, catalog()[0].2], 700)
}

struct Face {
    font: FontRef<'static>,
    layout: ttf_parser::Face<'static>,
    scale: PxScale,
    units: f32,
}

/// A family at a CSS pixel size (the em), ready to lay out.
pub struct SizedFont {
    faces: Vec<Face>,
}

/// One positioned glyph: its face, id and pen x (baseline at y = 0).
pub struct Placed {
    face: usize,
    glyph: GlyphId,
    pub x: f32,
}

impl SizedFont {
    pub fn new(css_or_family: &str, px: f32) -> SizedFont {
        let (bytes, weight) = faces_of(css_or_family);
        let faces = bytes
            .into_iter()
            .map(|bytes| {
                let mut font = FontRef::try_from_slice(bytes).expect("bundled font");
                let mut layout = ttf_parser::Face::parse(bytes, 0).expect("bundled font");
                // A variable face at the weight asked, as the browser instances it.
                font.set_variation(b"wght", weight as f32);
                layout.set_variation(ttf_parser::Tag::from_bytes(b"wght"), weight as f32);
                let upem = font.units_per_em().unwrap_or(1000.0);
                // CSS font-size is the em; ab_glyph's PxScale is the ascent-to-descent height.
                let scale = PxScale::from(px * font.height_unscaled() / upem);
                Face { layout, font, scale, units: px / upem }
            })
            .collect();
        SizedFont { faces }
    }

    fn glyph(&self, c: char) -> (usize, GlyphId) {
        for (i, f) in self.faces.iter().enumerate() {
            let id = f.font.glyph_id(c);
            if id.0 != 0 {
                return (i, id);
            }
        }
        (0, self.faces[0].font.glyph_id(c))
    }

    /// Glyphs with kerning, and the advance width.
    pub fn layout(&self, text: &str) -> (Vec<Placed>, f32) {
        let (mut x, mut out) = (0.0f32, Vec::new());
        let mut prev: Option<(usize, GlyphId)> = None;
        for c in text.chars() {
            let (fi, id) = self.glyph(c);
            let f = &self.faces[fi];
            let sf = f.font.as_scaled(f.scale);
            if let Some((pf, p)) = prev {
                if pf == fi {
                    x += sf.kern(p, id) + gpos_kern(&f.layout, p.0, id.0) as f32 * f.units;
                }
            }
            out.push(Placed { face: fi, glyph: id, x });
            x += sf.h_advance(id);
            prev = Some((fi, id));
        }
        (out, x)
    }

    /// How far the alphabetic baseline lies below the middle one (`textBaseline = "middle"`): half the
    /// font's ascent less its descent, px.
    pub fn middle(&self) -> f32 {
        let f = &self.faces[0];
        let sf = f.font.as_scaled(f.scale);
        (sf.ascent() + sf.descent()) / 2.0
    }

    /// Ink ascent and descent from the baseline (canvas `actualBoundingBox*`), whole pixels.
    pub fn ink(&self, text: &str) -> (f32, f32) {
        let (glyphs, _) = self.layout(text);
        let (mut asc, mut desc) = (0.0f32, 0.0f32);
        for g in glyphs {
            let f = &self.faces[g.face];
            if let Some(o) = f.font.outline_glyph(g.glyph.with_scale_and_position(f.scale, point(g.x, 0.0))) {
                let b = o.px_bounds();
                asc = asc.max(-b.min.y);
                desc = desc.max(b.max.y);
            }
        }
        (asc, desc)
    }

    /// Coverage of `text` with its baseline origin at (x, y), device pixels, `spacing` px after each
    /// character: calls `put(px, py, coverage)`.
    pub fn draw(&self, text: &str, x: f32, y: f32, spacing: f32, mut put: impl FnMut(i32, i32, f32)) {
        let (glyphs, _) = self.layout(text);
        for (i, g) in glyphs.into_iter().enumerate() {
            let f = &self.faces[g.face];
            let gx = x + g.x + spacing * i as f32;
            if let Some(o) = f.font.outline_glyph(g.glyph.with_scale_and_position(f.scale, point(gx, y))) {
                let b = o.px_bounds();
                o.draw(|px, py, c| put(b.min.x as i32 + px as i32, b.min.y as i32 + py as i32, c));
            }
        }
    }
}

/// Horizontal pair adjustment of the GPOS `kern` feature for (left, right), font units: the sum over
/// its lookups (each applied once, in lookup-list order) of the first pair subtable covering the pair.
fn gpos_kern(face: &ttf_parser::Face<'_>, left: u16, right: u16) -> i32 {
    use ttf_parser::gpos::{PairAdjustment, PositioningSubtable};
    use ttf_parser::GlyphId;
    let Some(gpos) = face.tables().gpos else { return 0 };
    let (l, r) = (GlyphId(left), GlyphId(right));
    let mut lookups: Vec<u16> = gpos.features.into_iter().filter(|f| f.tag == ttf_parser::Tag::from_bytes(b"kern")).flat_map(|f| f.lookup_indices).collect();
    lookups.sort_unstable();
    lookups.dedup();
    let mut total = 0i32;
    for index in lookups {
        let Some(lookup) = gpos.lookups.get(index) else { continue };
        for i in 0..lookup.subtables.len() {
            let Some(PositioningSubtable::Pair(pair)) = lookup.subtables.get::<PositioningSubtable<'_>>(i) else { continue };
            let Some(cov) = pair.coverage().get(l) else { continue };
            let value = match pair {
                PairAdjustment::Format1 { sets, .. } => sets.get(cov).and_then(|set| set.get(r)).map(|v| v.0.x_advance),
                PairAdjustment::Format2 { classes, matrix, .. } => matrix.get((classes.0.get(l), classes.1.get(r))).map(|v| v.0.x_advance),
            };
            if let Some(v) = value {
                total += v as i32;
                break;
            }
        }
    }
    total
}
