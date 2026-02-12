import OpenAI from "openai";
import OpusScript from "opusscript";
import type { CheekStreamConfig } from "../config/types.gateway.js";
import type { CheekStreamLog } from "./cheeko-stream.js";

/** 24kHz, mono, 20ms frame → 480 samples per frame, 2 bytes per sample = 960 bytes per frame. */
const TTS_SAMPLE_RATE = 24000;
const TTS_CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const FRAME_SIZE = (TTS_SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 480 samples
const FRAME_BYTE_SIZE = FRAME_SIZE * TTS_CHANNELS * 2; // 960 bytes (16-bit PCM)

export type CheekTtsCallbacks = {
  /** Called with each encoded Opus frame ready to send over WebSocket. */
  onOpusFrame: (frame: Buffer) => void;
  /** Called when all audio for a sentence has been sent. */
  onSentenceDone: () => void;
  /** Called on error. */
  onError: (err: string) => void;
};

export type CheekTtsHandle = {
  /** Abort the in-flight TTS request. */
  abort: () => void;
};

/**
 * Creates an Opus encoder instance (24kHz mono, VOIP application for low-latency speech).
 * Caller is responsible for calling `.delete()` when done.
 */
function createOpusEncoder(): OpusScript {
  const encoder = new OpusScript(TTS_SAMPLE_RATE, TTS_CHANNELS, OpusScript.Application.VOIP);
  encoder.setBitrate(32000); // 32kbps — good quality for voice
  return encoder;
}

/**
 * Streams TTS audio for a single text chunk.
 * Uses OpenAI TTS API to generate PCM audio, encodes to Opus frames,
 * and delivers each frame via the onOpusFrame callback.
 */
export function streamTts(opts: {
  text: string;
  config: CheekStreamConfig;
  log: CheekStreamLog;
  callbacks: CheekTtsCallbacks;
}): CheekTtsHandle {
  const { text, config, log, callbacks } = opts;
  const abortController = new AbortController();

  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    callbacks.onError("OpenAI API key not configured");
    return { abort: () => {} };
  }

  const model = config.ttsModel || "gpt-4o-mini-tts";
  const voice = config.ttsVoice || "alloy";

  const openai = new OpenAI({ apiKey });

  void (async () => {
    let encoder: OpusScript | null = null;
    try {
      encoder = createOpusEncoder();

      // Request PCM output for streaming — raw 24kHz 16-bit mono PCM
      const response = await openai.audio.speech.create(
        {
          model,
          voice,
          input: text,
          response_format: "pcm",
        },
      );

      if (abortController.signal.aborted) {
        encoder.delete();
        return;
      }

      // Get the response body as an ArrayBuffer and process in PCM frame chunks
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
      log.warn(`cheeko-tts: error: ${msg}`);
      callbacks.onError(msg);
    }
  })();

  return {
    abort() {
      abortController.abort();
    },
  };
}

/**
 * Manages streaming TTS for an entire LLM response.
 * Sentences are queued and processed sequentially to maintain natural ordering.
 * Opus frames are delivered as they're encoded.
 */
export function createTtsPipeline(opts: {
  config: CheekStreamConfig;
  log: CheekStreamLog;
  onOpusFrame: (frame: Buffer) => void;
  onComplete: () => void;
  onError: (err: string) => void;
}): {
  /** Enqueue a sentence for TTS. */
  pushSentence: (text: string) => void;
  /** Signal that no more sentences will arrive; complete after draining. */
  finish: () => void;
  /** Abort all pending and in-flight TTS. */
  abort: () => void;
} {
  const { config, log, onOpusFrame, onComplete, onError } = opts;

  const queue: string[] = [];
  let activeTts: CheekTtsHandle | null = null;
  let finished = false;
  let aborted = false;

  function processNext() {
    if (aborted) return;

    if (queue.length === 0) {
      if (finished) {
        onComplete();
      }
      return;
    }

    const text = queue.shift()!;
    log.info(`cheeko-tts: speaking sentence (${text.length} chars)`);

    activeTts = streamTts({
      text,
      config,
      log,
      callbacks: {
        onOpusFrame(frame) {
          if (!aborted) onOpusFrame(frame);
        },
        onSentenceDone() {
          activeTts = null;
          processNext();
        },
        onError(err) {
          activeTts = null;
          if (!aborted) onError(err);
        },
      },
    });
  }

  return {
    pushSentence(text: string) {
      if (aborted || finished) return;
      queue.push(text);
      // Start processing if nothing is active
      if (!activeTts) {
        processNext();
      }
    },
    finish() {
      if (aborted) return;
      finished = true;
      // If nothing is active, complete immediately
      if (!activeTts && queue.length === 0) {
        onComplete();
      }
    },
    abort() {
      aborted = true;
      queue.length = 0;
      if (activeTts) {
        activeTts.abort();
        activeTts = null;
      }
    },
  };
}
