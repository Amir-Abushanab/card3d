//! WOFF and WOFF2 pack fonts on the native host (`text::sfnt`, `text::register`).

use card3d_native::text::{register, sfnt, SizedFont};

const WEB_FONTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/core/assets/fonts/");

/// The card fonts are the web package's WOFF2 files, decoded once (`text`): every face decodes, and the
/// variable Inter set to weight 700 has the advances of the static 700 instance it replaced (font units,
/// measured on that instance).
#[test]
fn web_woff2_card_fonts_decode_and_inter_is_set_to_700() {
    for entry in std::fs::read_dir(WEB_FONTS).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "woff2") {
            let ttf = sfnt(std::fs::read(&path).unwrap()).unwrap_or_else(|| panic!("{} decodes", path.display()));
            assert!(ttf_parser::Face::parse(&ttf, 0).is_ok(), "{}", path.display());
        }
    }
    let inter = sfnt(std::fs::read(format!("{WEB_FONTS}inter-latin-wght-normal.woff2")).unwrap()).unwrap();
    let mut face = ttf_parser::Face::parse(&inter, 0).unwrap();
    assert!(face.is_variable());
    face.set_variation(ttf_parser::Tag::from_bytes(b"wght"), 700.0);
    for (c, advance) in [('A', 1529), ('d', 1291), ('a', 1189), ('W', 2125), ('0', 1381)] {
        assert_eq!(face.glyph_hor_advance(face.glyph_index(c).unwrap()), Some(advance), "{c}");
    }
    // The renderer's Inter lays text out at 700, not the variable font's default weight.
    assert!(register("Pack Inter", 400, std::fs::read(format!("{WEB_FONTS}inter-latin-wght-normal.woff2")).unwrap()));
    let (bold, regular) = (SizedFont::new("700 100px \"card3d Inter\"", 100.0), SizedFont::new("400 100px \"Pack Inter\"", 100.0));
    assert!(bold.layout("ADA LOVELACE").1 > regular.layout("ADA LOVELACE").1);
}

/// A WOFF 1.0 file of `ttf` (each table zlib-compressed when that is smaller), per the W3C spec.
fn woff1(ttf: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let u16_at = |o: usize| u16::from_be_bytes([ttf[o], ttf[o + 1]]);
    let u32_at = |o: usize| u32::from_be_bytes([ttf[o], ttf[o + 1], ttf[o + 2], ttf[o + 3]]);
    let n = u16_at(4) as usize;
    let mut tables = Vec::new();
    for i in 0..n {
        let r = 12 + 16 * i;
        let (tag, checksum, offset, length) = (u32_at(r), u32_at(r + 4), u32_at(r + 8) as usize, u32_at(r + 12) as usize);
        let data = &ttf[offset..offset + length];
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        z.write_all(data).unwrap();
        let z = z.finish().unwrap();
        tables.push((tag, checksum, if z.len() < data.len() { z } else { data.to_vec() }, length));
    }
    let mut body = Vec::new();
    let mut dir = Vec::new();
    let start = 44 + 20 * n;
    for (tag, checksum, data, orig) in &tables {
        let offset = start + body.len();
        dir.extend(tag.to_be_bytes());
        dir.extend((offset as u32).to_be_bytes());
        dir.extend((data.len() as u32).to_be_bytes());
        dir.extend((*orig as u32).to_be_bytes());
        dir.extend(checksum.to_be_bytes());
        body.extend(data);
        body.resize(body.len().div_ceil(4) * 4, 0);
    }
    let total_sfnt = 12 + 16 * n + tables.iter().map(|t| t.3.div_ceil(4) * 4).sum::<usize>();
    let mut out = Vec::new();
    out.extend(b"wOFF");
    out.extend(u32_at(0).to_be_bytes());
    out.extend(((start + body.len()) as u32).to_be_bytes());
    out.extend((n as u16).to_be_bytes());
    out.extend(0u16.to_be_bytes());
    out.extend((total_sfnt as u32).to_be_bytes());
    out.extend([0u8; 4]); // version
    out.extend([0u8; 12]); // metadata offset, length, original length
    out.extend([0u8; 8]); // private data offset, length
    out.extend(dir);
    out.extend(body);
    out
}

#[test]
fn woff1_decodes_and_registers() {
    let ttf = sfnt(std::fs::read(format!("{WEB_FONTS}unbounded-latin-700-normal.woff2")).unwrap()).unwrap();
    let woff = woff1(&ttf);
    assert!(woff.len() < ttf.len());
    let decoded = sfnt(woff.clone()).expect("decodes");
    let (a, b) = (ttf_parser::Face::parse(&decoded, 0).unwrap(), ttf_parser::Face::parse(&ttf, 0).unwrap());
    assert_eq!(a.number_of_glyphs(), b.number_of_glyphs());
    // Registered under a family, it lays out exactly as the bundled face does.
    assert!(register("Pack Sans", 700, woff));
    let (pack, bundled) = (SizedFont::new("700 40px \"Pack Sans\"", 40.0), SizedFont::new("700 40px \"card3d Unbounded\"", 40.0));
    assert_eq!(pack.layout("ADA LOVELACE").1, bundled.layout("ADA LOVELACE").1);
    // A WOFF2 pack font too; and broken files are refused.
    assert!(register("Pack Serif", 700, std::fs::read(format!("{WEB_FONTS}playfair-display-latin-700-normal.woff2")).unwrap()));
    assert!(!register("Broken", 700, b"wOF2 not really".to_vec()));
    assert!(sfnt(b"wOFF".to_vec()).is_none());
}
