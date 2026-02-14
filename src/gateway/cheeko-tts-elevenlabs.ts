import OpusScript from "opusscript";
import type { CheekStreamConfig } from "../config/types.gateway.js";
import type { CheekTtsCallbacks, CheekTtsHandle } from "./cheeko-tts.js";
import type { CheekAudioFormat, CheekStreamLog } from "./cheeko-stream.js";

/** 24kHz, mono, 20ms frame → 480 samples per frame, 2 bytes per sample = 960 bytes per frame. */
const TTS_SAMPLE_RATE = 24000;
const TTS_CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const FRAME_SIZE = (TTS_SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 480 samples
const FRAME_BYTE_SIZE = FRAME_SIZE * TTS_CHANNELS * 2; // 960 bytes (16-bit PCM)

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_turbo_v2";

function createOpusEncoder(): OpusScript {
  const encoder = new OpusScript(TTS_SAMPLE_RATE, TTS_CHANNELS, OpusScript.Application.VOIP);
  encoder.setBitrate(32000);
  return encoder;
}

/**
 * Encodes complete PCM frames from a carry buffer and emits them via callback.
 * Returns any leftover bytes that don't fill a complete frame.
 */
function encodeAndEmitFrames(
  carry: Buffer,
  chunk: Buffer,
  encoder: OpusScript,
  onFrame: (frame: Buffer) => void,
  abortSignal: AbortSignal,
): Buffer {
  const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
  let offset = 0;
  while (offset + FRAME_BYTE_SIZE <= combined.length) {
    if (abortSignal.aborted) return Buffer.alloc(0);
    const frame = combined.subarray(offset, offset + FRAME_BYTE_SIZE);
    const opusFrame = encoder.encode(frame, FRAME_SIZE);
    onFrame(Buffer.from(opusFrame));
    offset += FRAME_BYTE_SIZE;
  }
  // Return leftover bytes that don't fill a complete frame
  return offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);
}

/**
 * Streams TTS audio for a single text chunk using ElevenLabs API.
 * Reads the response body as a stream — encodes and sends Opus frames
 * as PCM chunks arrive, rather than buffering the entire response first.
 */
export function streamElevenLabsTts(opts: {
  text: string;
  config: CheekStreamConfig;
  log: CheekStreamLog;
  outputFormat?: CheekAudioFormat;
  callbacks: CheekTtsCallbacks;
}): CheekTtsHandle {
  const { text, config, log, callbacks } = opts;
  const outputFormat = opts.outputFormat ?? "opus";
  const abortController = new AbortController();

  const apiKey = config.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  if (!apiKey) {
    callbacks.onError("ElevenLabs API key not configured");
    return { abort: () => {} };
  }

  const voiceId = config.elevenlabsVoiceId || DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = config.elevenlabsModelId || DEFAULT_ELEVENLABS_MODEL_ID;

  void (async () => {
    let encoder: OpusScript | null = null;
    try {
      if (outputFormat === "opus") {
        encoder = createOpusEncoder();
      }

      const url = new URL(
        `${DEFAULT_ELEVENLABS_BASE_URL}/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`,
      );

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/pcm",
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`ElevenLabs API error (${response.status}): ${errText}`);
      }

      if (abortController.signal.aborted) {
        encoder?.delete();
        return;
      }

      const body = response.body;
      if (!body) {
        throw new Error("ElevenLabs response has no readable body");
      }

      if (outputFormat === "pcm") {
        // Stream raw PCM chunks directly to web clients
        for await (const chunk of body) {
          if (abortController.signal.aborted) break;
          callbacks.onAudioFrame(Buffer.from(chunk));
        }
      } else {
        // Stream PCM chunks, encode to Opus frames, send as they arrive
        let carry = Buffer.alloc(0);
        for await (const chunk of body) {
          if (abortController.signal.aborted) break;
          carry = encodeAndEmitFrames(
            carry,
            Buffer.from(chunk),
            encoder!,
            (frame) => callbacks.onAudioFrame(frame),
            abortController.signal,
          );
        }
        // Flush any remaining partial frame (pad with silence)
        if (carry.length > 0 && !abortController.signal.aborted) {
          const padded = Buffer.alloc(FRAME_BYTE_SIZE);
          carry.copy(padded);
          const opusFrame = encoder!.encode(padded, FRAME_SIZE);
          callbacks.onAudioFrame(Buffer.from(opusFrame));
        }
        encoder!.delete();
        encoder = null;
      }

      if (!abortController.signal.aborted) {
        callbacks.onSentenceDone();
      }
    } catch (err: unknown) {
      encoder?.delete();
      if (abortController.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`cheeko-tts-elevenlabs: error: ${msg}`);
      callbacks.onError(msg);
    }
  })();

  return {
    abort() {
      abortController.abort();
    },
  };
}
