//! The native host as apps use it: `card3d_native::NativeHost` (data URLs and files) plus the app's
//! downloads. The engine reads nothing from the network; the app fetches a design's remote files
//! (`Assets::files`: URL → local path, see `remote_urls`) and the host reads those instead.

use card3d_engine::canvas::{Canvas, EnvironmentFile, Host, Image, ImagePurpose};
use card3d_engine::json::Value;
use card3d_native::NativeHost;
use std::path::PathBuf;

/// What the app supplies with a design (`card3d_stage_set_design`'s `assets` JSON):
///
/// ```json
/// { "files": { "https://…/sticker.png": "/…/Caches/card3d/3f…a1.png" },
///   "base": "/dir/relative/srcs/resolve/against",
///   "nameFontFamily": "…" }
/// ```
///
/// Every field is optional.
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Assets {
    pub files: Vec<(String, String)>,
    pub base: Option<PathBuf>,
    pub name_font: Option<String>,
}

impl Assets {
    /// Reads the `assets` JSON (empty or absent: none). Unknown fields are ignored.
    pub fn parse(json: &str) -> Result<Assets, String> {
        if json.trim().is_empty() {
            return Ok(Assets::default());
        }
        let v = card3d_engine::json::parse(json).map_err(|e| format!("assets: {e}"))?;
        let Some(o) = v.as_object() else { return Err("assets: expected an object".into()) };
        let strings = |v: Option<&Value>| -> Vec<(String, String)> {
            v.and_then(Value::as_object).map_or_else(Vec::new, |m| m.iter().filter_map(|(k, v)| Some((k.to_string(), v.as_str()?.to_string()))).collect())
        };
        Ok(Assets {
            files: strings(o.get("files")),
            base: o.get("base").and_then(Value::as_str).filter(|s| !s.is_empty()).map(PathBuf::from),
            name_font: o.get("nameFontFamily").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        })
    }
}

/// `NativeHost` with the app's downloads in place of their URLs. `Send`: the GIF stickers decode on a
/// worker thread with a clone.
#[derive(Clone)]
pub struct MappedHost {
    inner: NativeHost,
    files: Vec<(String, String)>,
}

impl MappedHost {
    pub fn new(assets: &Assets, environments: Option<PathBuf>) -> MappedHost {
        let inner = NativeHost { base: assets.base.clone(), environments, name_font: assets.name_font.clone() };
        MappedHost { inner, files: assets.files.clone() }
    }

    /// The local file for `src` when the app downloaded it, else `src` itself.
    fn local<'a>(&'a self, src: &'a str) -> &'a str {
        self.files.iter().find(|(url, _)| url == src).map_or(src, |(_, path)| path.as_str())
    }
}

impl Host for MappedHost {
    fn canvas(&self, width: u32, height: u32) -> Box<dyn Canvas> {
        self.inner.canvas(width, height)
    }
    fn image(&self, src: &str, purpose: ImagePurpose) -> Option<Image> {
        let local = self.local(src);
        // SVG masks are recognised by name: keep the URL's extension visible to the host.
        if local != src && purpose == ImagePurpose::Mask && is_svg(src) && !is_svg(local) {
            let bytes = std::fs::read(local).ok()?;
            let data = format!("data:image/svg+xml;base64,{}", base64(&bytes));
            return self.inner.image(&data, purpose);
        }
        self.inner.image(local, purpose)
    }
    fn environment(&self, src: &str) -> Option<EnvironmentFile> {
        self.inner.environment(self.local(src))
    }
    fn name_font(&self) -> String {
        self.inner.name_font()
    }
    fn file(&self, src: &str) -> Option<Vec<u8>> {
        self.inner.file(self.local(src))
    }
}

fn is_svg(src: &str) -> bool {
    src.split(['?', '#']).next().unwrap_or(src).to_ascii_lowercase().ends_with(".svg") || src.starts_with("data:image/svg+xml")
}

/// Standard base64 with padding.
fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = ((c[0] as u32) << 16) | ((*c.get(1).unwrap_or(&0) as u32) << 8) | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[((n >> (18 - 6 * i)) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The `http(s)` URLs a design names, in order, once each: what the app downloads before
/// `set_design` (images, stickers and GIFs, artwork, a logo, a custom font file, a scene's environment
/// file). Strings anywhere in the design count, so a new field that
/// takes a URL is covered without a change here.
pub fn remote_urls(design: &Value) -> Vec<String> {
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => {
                let lower = s.get(..8).unwrap_or(s).to_ascii_lowercase();
                if (lower.starts_with("https://") || lower.starts_with("http://")) && !out.contains(s) {
                    out.push(s.clone());
                }
            }
            Value::Array(a) => a.iter().for_each(|v| walk(v, out)),
            Value::Object(m) => m.iter().for_each(|(_, v)| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(design, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_pads() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
    }
}
