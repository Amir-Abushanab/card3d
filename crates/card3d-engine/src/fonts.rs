//! Which font family each piece of card text uses (`designFontFamily`, `textLineFamilies` in
//! packages/core/src/fonts.ts). Hosts load the faces (the web wrapper with core's TypeScript font
//! loaders; card3d-native bundles the catalog); the engine only names the family.

use crate::design::CardDesign;

/// The catalog (`CARD_FONTS`): id → registered family.
pub const CARD_FONTS: [(&str, &str); 6] = [
    ("inter", "card3d Inter"),
    ("manrope", "card3d Manrope"),
    ("space-grotesk", "card3d Space Grotesk"),
    ("unbounded", "card3d Unbounded"),
    ("playfair", "card3d Playfair Display"),
    ("plex-mono", "card3d IBM Plex Mono"),
];

/// The public provider's name font (`DEFAULT_CARD_FONT`).
pub const DEFAULT_FAMILY: &str = "card3d Inter";

pub fn card_font_family(id: &str) -> Option<&'static str> {
    CARD_FONTS.iter().find(|(i, _)| *i == id).map(|(_, f)| *f)
}

/// The families a design's text uses: the name and bio, and each extra text line (non-empty text
/// only, at most three, in order).
#[derive(Clone, Debug, PartialEq)]
pub struct FontFamilies {
    pub name: String,
    pub lines: Vec<String>,
}

/// `designFontFamily` + `textLineFamilies` for catalog fonts. A custom font (an object: Google, URL,
/// upload) needs the host's loaded family: pass it as `custom_name` (else the provider's `default` is
/// used, as the TypeScript engine does when a custom font fails to load).
pub fn resolve(design: &CardDesign, custom_name: Option<&str>, default: &str) -> FontFamilies {
    let name = match &design.font {
        Some(crate::json::Value::String(id)) => card_font_family(id).unwrap_or(default).to_string(),
        Some(crate::json::Value::Object(_)) => custom_name.unwrap_or(default).to_string(),
        _ => default.to_string(),
    };
    let lines = design
        .text_lines
        .iter()
        .filter(|l| !l.text.trim().is_empty())
        .take(3)
        .map(|l| l.font.as_deref().and_then(card_font_family).map_or_else(|| name.clone(), str::to_string))
        .collect();
    FontFamilies { name, lines }
}
