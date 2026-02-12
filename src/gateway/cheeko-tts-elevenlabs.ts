import OpusScript from "opusscript";
import type { CheekStreamConfig } from "../config/types.gateway.js";
import type { CheekTtsCallbacks, CheekTtsHandle } from "./cheeko-tts.js";
import type { CheekStreamLog } from "./cheeko-stream.js";

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
 * Streams TTS audio for a single text chunk using ElevenLabs API.
 * Requests pcm_24000 output, encodes to Opus frames, and delivers via callbacks.
 */
export function streamElevenLabsTts(opts: {
  text: string;
  config: CheekStreamConfig;
  log: CheekStreamLog;
  callbacks: CheekTtsCallbacks;
}): CheekTtsHandle {
  const { text, config, log, callbacks } = opts;
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
      encoder = createOpusEncoder();

      const url = new URL(
        `${DEFAULT_ELEVENLABS_BASE_URL}/v1/text-to-speech/${voiceId}?output_format=pcm_24000`,
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
        encoder.delete();
        return;
      }

      const arrayBuffer = await response.arrayBuffer();

      if (abortController.signal.aborted) {
        encoder.delete();
        return;
      }

      const pcmBuffer = Buffer.from(arrayBuffer);
      let offset = 0;

      while (offset + FRAME_BYTE_SIZE <= pcmBuffer.length) {
        if (abortController.signal.aborted) break;

        const frame = pcmBuffer.subarray(offset, offset + FRAME_BYTE_SIZE);
        const opusFrame = encoder.encode(frame, FRAME_SIZE);
        callbacks.onOpusFrame(Buffer.from(opusFrame));
        offset += FRAME_BYTE_SIZE;
      }

      // Encode any remaining partial frame (pad with silence)
      if (offset < pcmBuffer.length && !abortController.signal.aborted) {
        const remaining = pcmBuffer.subarray(offset);
        const padded = Buffer.alloc(FRAME_BYTE_SIZE);
        remaining.copy(padded);
        const opusFrame = encoder.encode(padded, FRAME_SIZE);
        callbacks.onOpusFrame(Buffer.from(opusFrame));
      }

      encoder.delete();
      encoder = null;

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
