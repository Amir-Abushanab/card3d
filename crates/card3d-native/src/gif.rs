//! Animated GIF stickers for native hosts: the native half of packages/core/wasm/gif-stickers.js. Each
//! GIF is decoded (the `image` crate composites the frames), every frame is drawn inside its die-cut
//! border (`bordered_frame`, the same canvas steps as the page's `borderedFrame`, on the host's
//! tiny-skia canvases), and the frames are handed to the engine with `Stage::show_sticker_frame`.
//!
//! Time is the host's: [`AnimatedStickers::update`] takes the seconds since the card was shown and
//! sends each sticker the frame due then, only when it changes. The frames loop with each frame's own
//! delay, at least 1/30 s and at most 10 s, as the page plays them. A render that must not move (the
//! comparison harness, exports) calls `update(0.0, …)` once: the first frame, as the page shows it.
//!
//! Decoding and the borders are CPU work and `Send`: a host can build [`AnimatedStickers`] on a worker
//! thread and call `update` on the thread that owns the stage.

use card3d_engine::canvas::{Composite, Host, Image, Paint};

const MAX_SIDE: f64 = 720.0;
const BORDER_COLOR: &str = "#f4f1e7";
const TAPS: usize = 32;
const MIN_FRAME_S: f64 = 1.0 / 30.0;
const MAX_FRAME_S: f64 = 10.0;

/// One bordered frame: straight-alpha RGBA, row 0 at the top, and how long it shows (seconds).
#[derive(Clone, Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub seconds: f64,
}

/// A decoded GIF's frames, bordered.
#[derive(Clone, Debug)]
pub struct GifSticker {
    pub frames: Vec<Frame>,
}

impl GifSticker {
    /// Decodes a GIF and borders every frame; `None` when it isn't a GIF the decoder reads (the
    /// sticker then stays blank, as on the web).
    pub fn decode(bytes: &[u8], host: &dyn Host) -> Option<GifSticker> {
        use image::AnimationDecoder;
        let decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)).ok()?;
        let mut frames = Vec::new();
        for f in decoder.into_frames() {
            let f = f.ok()?;
            let (num, den) = f.delay().numer_denom_ms();
            let seconds = (num as f64 / den.max(1) as f64 / 1000.0).clamp(MIN_FRAME_S, MAX_FRAME_S);
            let buf = f.into_buffer();
            let (w, h) = buf.dimensions();
            let (width, height, rgba) = bordered_frame(host, &Image { width: w, height: h, rgba: buf.into_raw() });
            frames.push(Frame { width, height, rgba, seconds });
        }
        (!frames.is_empty()).then_some(GifSticker { frames })
    }

    /// The frame shown `time` seconds after the start (looping).
    pub fn frame_at(&self, time: f64) -> usize {
        if self.frames.len() < 2 {
            return 0;
        }
        let total: f64 = self.frames.iter().map(|f| f.seconds).sum();
        let mut t = time.max(0.0) % total;
        for (i, f) in self.frames.iter().enumerate() {
            if t < f.seconds {
                return i;
            }
            t -= f.seconds;
        }
        self.frames.len() - 1
    }

    /// Seconds from `time` until the frame changes (`None` for a still GIF).
    pub fn until_next(&self, time: f64) -> Option<f64> {
        if self.frames.len() < 2 {
            return None;
        }
        let total: f64 = self.frames.iter().map(|f| f.seconds).sum();
        let t = time.max(0.0) % total;
        let mut end = 0.0;
        for f in &self.frames {
            end += f.seconds;
            if t < end {
                return Some(end - t);
            }
        }
        Some(total - t)
    }
}

/// `borderedFrame`: the frame scaled to at most 720 px, padded, a 32-tap cream dilation of its
/// silhouette behind it. Returns (width, height, straight RGBA).
pub fn bordered_frame(host: &dyn Host, frame: &Image) -> (u32, u32, Vec<u8>) {
    let (w, h) = (frame.width as f64, frame.height as f64);
    let k = (MAX_SIDE / w.max(h)).min(1.0);
    let iw = ((w * k).round() as u32).max(1);
    let ih = ((h * k).round() as u32).max(1);
    let p = (0.035 * iw.max(ih) as f64).round().max(7.0);
    let mut a = host.canvas(iw, ih);
    a.set_smoothing_high();
    a.draw_image(frame, 0.0, 0.0, iw as f64, ih as f64);
    let mut b = host.canvas(iw, ih);
    b.draw_canvas(a.as_ref(), 0.0, 0.0, iw as f64, ih as f64);
    b.set_composite(Composite::SourceIn);
    b.set_fill(Paint::Color(BORDER_COLOR.into()));
    b.fill_rect(0.0, 0.0, iw as f64, ih as f64);
    let (ow, oh) = (iw + 2 * p as u32, ih + 2 * p as u32);
    let mut o = host.canvas(ow, oh);
    let rho = 0.72 * p;
    for j in 0..TAPS {
        let phi = 2.0 * std::f64::consts::PI * j as f64 / TAPS as f64;
        o.draw_canvas(b.as_ref(), p + rho * phi.cos(), p + rho * phi.sin(), iw as f64, ih as f64);
    }
    o.draw_canvas(a.as_ref(), p, p, iw as f64, ih as f64);
    (ow, oh, o.get_image_data())
}

/// A card's animated stickers and the frame each one shows.
#[derive(Default)]
pub struct AnimatedStickers {
    stickers: Vec<(usize, GifSticker, Option<usize>)>,
}

impl AnimatedStickers {
    /// Decodes the GIFs of `decals` (`Stage::animated_stickers()`: indices into `design.decals`),
    /// reading their `src`s through `host` (`Host::file`: data URLs and files).
    pub fn load(host: &dyn Host, design: &card3d_engine::CardDesign, decals: &[usize]) -> AnimatedStickers {
        let stickers = decals
            .iter()
            .filter_map(|&i| {
                let src = design.decals.get(i)?.src.as_deref()?;
                let gif = GifSticker::decode(&host.file(src)?, host)?;
                Some((i, gif, None))
            })
            .collect();
        AnimatedStickers { stickers }
    }

    pub fn is_empty(&self) -> bool {
        self.stickers.is_empty()
    }

    /// Sends each sticker the frame due `time` seconds after the start, when it differs from the one it
    /// shows: `show(decal, width, height, rgba)`, for `Stage::show_sticker_frame`. Returns the seconds
    /// until the next frame change (`None` when nothing animates).
    pub fn update(&mut self, time: f64, mut show: impl FnMut(usize, u32, u32, &[u8])) -> Option<f64> {
        let mut next: Option<f64> = None;
        for (decal, gif, shown) in &mut self.stickers {
            let i = gif.frame_at(time);
            if *shown != Some(i) {
                let f = &gif.frames[i];
                show(*decal, f.width, f.height, &f.rgba);
                *shown = Some(i);
            }
            if let Some(dt) = gif.until_next(time) {
                next = Some(next.map_or(dt, |n| n.min(dt)));
            }
        }
        next
    }

    /// Forgets which frames were sent, so the next `update` sends them all again (a rebuilt card).
    pub fn reset(&mut self) {
        for s in &mut self.stickers {
            s.2 = None;
        }
    }
}
