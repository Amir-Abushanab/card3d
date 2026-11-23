/**
 * WebCodecs video for clip export, loaded on demand (exporters.ts): mediabunny encodes and muxes, so
 * every frame gets an exact timestamp. Named imports only, so the bundle keeps just what is used.
 */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat, getFirstEncodableVideoCodec, type VideoCodec } from "mediabunny";

/** The codecs tried for each container, most compatible first. */
const CODECS: Record<"mp4" | "webm", VideoCodec[]> = { mp4: ["avc", "hevc", "av1"], webm: ["vp9", "vp8", "av1"] };

export interface CanvasVideo {
  /** Encode the canvas as it is now, as the frame at `seconds` lasting `duration`. */
  add(seconds: number, duration: number): Promise<void>;
  finish(): Promise<Blob | null>;
  cancel(): Promise<void>;
}

/** A WebCodecs encoder reading `canvas`, or null when the browser can't encode this container. */
export async function canvasVideo(canvas: HTMLCanvasElement, format: "mp4" | "webm", fps: number, bitrate: number): Promise<CanvasVideo | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const codec = await getFirstEncodableVideoCodec(CODECS[format], { width: canvas.width, height: canvas.height, bitrate, frameRate: fps });
  if (!codec) return null;
  const target = new BufferTarget();
  const output = new Output({ format: format === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target });
  const source = new CanvasSource(canvas, { codec, bitrate });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  return {
    add: (seconds, duration) => source.add(seconds, duration),
    async finish() {
      await output.finalize();
      return target.buffer ? new Blob([target.buffer], { type: output.format.mimeType }) : null;
    },
    cancel: () => output.cancel().catch(() => {}),
  };
}
