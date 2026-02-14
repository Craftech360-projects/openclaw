import { spawn, type ChildProcess } from "node:child_process";
import OpusScript from "opusscript";
import type { CheekAudioFormat, CheekStreamLog } from "./cheeko-stream.js";

/** 24kHz mono 20ms — same constants as cheeko-tts. */
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 480 samples
const FRAME_BYTE_SIZE = FRAME_SIZE * CHANNELS * 2; // 960 bytes (16-bit PCM)

export type MusicHandle = {
  abort: () => void;
};

export type StreamMusicOpts = {
  query: string;
  outputFormat: CheekAudioFormat;
  log: CheekStreamLog;
  onAudioFrame: (frame: Buffer) => void;
  onComplete: () => void;
  onError: (msg: string) => void;
};

/**
 * Streams music audio for a YouTube search query.
 *
 * 1. Runs `yt-dlp` to search YouTube and get the best audio URL.
 * 2. Pipes that URL into `ffmpeg` to transcode to 24kHz mono 16-bit PCM.
 * 3. Reads ffmpeg stdout in 960-byte frames (20ms), optionally encodes to Opus.
 * 4. Delivers frames via `onAudioFrame()`.
 */
export function streamMusic(opts: StreamMusicOpts): MusicHandle {
  const { query, outputFormat, log, onAudioFrame, onComplete, onError } = opts;
  let aborted = false;
  const children: ChildProcess[] = [];

  function killAll() {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    children.length = 0;
  }

  void (async () => {
    let encoder: OpusScript | null = null;
    try {
      // Step 1: Get audio URL via yt-dlp
      log.info(`cheeko-music: searching YouTube for "${query}"`);
      const audioUrl = await getAudioUrl(query, children, log);

      if (aborted) return;
      if (!audioUrl) {
        onError("No audio URL found for query");
        return;
      }

      log.info(`cheeko-music: got audio URL, starting ffmpeg transcode`);

      // Step 2: Transcode with ffmpeg
      const ffmpeg = spawn("ffmpeg", [
        "-i", audioUrl,
        "-f", "s16le",
        "-ar", String(SAMPLE_RATE),
        "-ac", String(CHANNELS),
        "-loglevel", "error",
        "pipe:1",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      children.push(ffmpeg);

      if (outputFormat === "opus") {
        encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
        encoder.setBitrate(64000); // 64kbps for music (higher than 32kbps voice)
      }

      let carry = Buffer.alloc(0);
      let totalFrames = 0;

      ffmpeg.stdout!.on("data", (chunk: Buffer) => {
        if (aborted) return;

        const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        let offset = 0;

        while (offset + FRAME_BYTE_SIZE <= combined.length) {
          if (aborted) break;
          const frame = combined.subarray(offset, offset + FRAME_BYTE_SIZE);

          if (encoder) {
            const opusFrame = encoder.encode(frame, FRAME_SIZE);
            onAudioFrame(Buffer.from(opusFrame));
          } else {
            onAudioFrame(Buffer.from(frame));
          }
          totalFrames++;
          offset += FRAME_BYTE_SIZE;
        }

        carry = offset < combined.length
          ? Buffer.from(combined.subarray(offset))
          : Buffer.alloc(0);
      });

      let stderrText = "";
      ffmpeg.stderr!.on("data", (chunk: Buffer) => {
        stderrText += chunk.toString();
      });

      await new Promise<void>((resolve, reject) => {
        ffmpeg.on("close", (code) => {
          if (aborted) {
            resolve();
            return;
          }
          if (code !== 0 && code !== null) {
            reject(new Error(`ffmpeg exited with code ${code}: ${stderrText.slice(0, 200)}`));
          } else {
            resolve();
          }
        });
        ffmpeg.on("error", reject);
      });

      if (aborted) return;

      // Flush remaining partial frame (pad with silence)
      if (carry.length > 0) {
        const padded = Buffer.alloc(FRAME_BYTE_SIZE);
        carry.copy(padded);
        if (encoder) {
          const opusFrame = encoder.encode(padded, FRAME_SIZE);
          onAudioFrame(Buffer.from(opusFrame));
        } else {
          onAudioFrame(padded);
        }
        totalFrames++;
      }

      encoder?.delete();
      encoder = null;

      log.info(`cheeko-music: streaming complete (${totalFrames} frames)`);
      onComplete();
    } catch (err: unknown) {
      encoder?.delete();
      killAll();
      if (aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`cheeko-music: error: ${msg}`);
      onError(msg);
    }
  })();

  return {
    abort() {
      if (aborted) return;
      aborted = true;
      killAll();
      log.info("cheeko-music: aborted");
    },
  };
}

/**
 * Uses yt-dlp to search YouTube and return the best audio stream URL.
 */
async function getAudioUrl(
  query: string,
  children: ChildProcess[],
  log: CheekStreamLog,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn("yt-dlp", [
      "--no-playlist",
      "-f", "bestaudio",
      "--get-url",
      `ytsearch1:${query}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(ytdlp);

    let stdout = "";
    let stderr = "";

    ytdlp.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    ytdlp.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ytdlp.on("close", (code) => {
      const idx = children.indexOf(ytdlp);
      if (idx !== -1) children.splice(idx, 1);

      if (code !== 0) {
        log.warn(`cheeko-music: yt-dlp exited with code ${code}: ${stderr.slice(0, 200)}`);
        reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      const url = stdout.trim().split("\n")[0]?.trim();
      resolve(url || null);
    });

    ytdlp.on("error", (err) => {
      log.warn(`cheeko-music: yt-dlp spawn error: ${err.message}`);
      reject(err);
    });
  });
}
