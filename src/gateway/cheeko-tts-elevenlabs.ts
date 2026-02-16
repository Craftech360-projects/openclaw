import OpusScript from "opusscript";
import type { CheekStreamConfig } from "../config/types.gateway.js";
import type { CheekAudioFormat, CheekStreamLog } from "./cheeko-stream.js";
import { paceFrames, type CheekTtsCallbacks, type CheekTtsHandle } from "./cheeko-tts.js";

/** 24kHz, mono, 60ms frame → 1440 samples per frame, 2 bytes per sample = 2880 bytes per frame. */
const TTS_SAMPLE_RATE = 24000;
const TTS_CHANNELS = 1;
const FRAME_DURATION_MS = 60;
const FRAME_SIZE = (TTS_SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 1440 samples
const FRAME_BYTE_SIZE = FRAME_SIZE * TTS_CHANNELS * 2; // 2880 bytes (16-bit PCM)

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
 * Requests pcm_24000 output, optionally encodes to Opus, and delivers via callbacks.
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

  const apiKey =
    config.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
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
        encoder?.delete();
        return;
      }

      const arrayBuffer = await response.arrayBuffer();

      if (abortController.signal.aborted) {
        encoder?.delete();
        return;
      }

      const pcmBuffer = Buffer.from(arrayBuffer);

      if (outputFormat === "pcm") {
        // Send raw PCM directly to web clients
        callbacks.onAudioFrame(pcmBuffer);
        if (!abortController.signal.aborted) {
          callbacks.onSentenceDone();
        }
      } else {
        // Encode all frames first, then pace delivery
        const opusFrames: Buffer[] = [];
        let offset = 0;
        while (offset + FRAME_BYTE_SIZE <= pcmBuffer.length) {
          const frame = pcmBuffer.subarray(offset, offset + FRAME_BYTE_SIZE);
          opusFrames.push(Buffer.from(encoder!.encode(frame, FRAME_SIZE)));
          offset += FRAME_BYTE_SIZE;
        }
        if (offset < pcmBuffer.length) {
          const padded = Buffer.alloc(FRAME_BYTE_SIZE);
          pcmBuffer.subarray(offset).copy(padded);
          opusFrames.push(Buffer.from(encoder!.encode(padded, FRAME_SIZE)));
        }
        encoder!.delete();
        encoder = null;

        // Pace frames at real-time rate so the device buffer doesn't overflow
        await paceFrames(
          opusFrames,
          FRAME_DURATION_MS,
          abortController.signal,
          callbacks.onAudioFrame,
        );

        if (!abortController.signal.aborted) {
          callbacks.onSentenceDone();
        }
      }
    } catch (err: unknown) {
      encoder?.delete();
      if (abortController.signal.aborted) {
        return;
      }
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
