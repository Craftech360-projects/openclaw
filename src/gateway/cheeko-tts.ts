import OpenAI from "openai";
import OpusScript from "opusscript";
import type { CheekStreamConfig } from "../config/types.gateway.js";
import type { CheekAudioFormat, CheekStreamLog } from "./cheeko-stream.js";
import { streamElevenLabsTts } from "./cheeko-tts-elevenlabs.js";

/** 24kHz, mono, 60ms frame → 1440 samples per frame, 2 bytes per sample = 2880 bytes per frame. */
const TTS_SAMPLE_RATE = 24000;
const TTS_CHANNELS = 1;
const FRAME_DURATION_MS = 60;
const FRAME_SIZE = (TTS_SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 1440 samples
const FRAME_BYTE_SIZE = FRAME_SIZE * TTS_CHANNELS * 2; // 2880 bytes (16-bit PCM)

export type CheekTtsCallbacks = {
  /** Called with each audio frame (Opus or raw PCM) ready to send over WebSocket. */
  onAudioFrame: (frame: Buffer) => void;
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
 * Delivers Opus frames at real-time rate to avoid overwhelming device buffers.
 * Sends one frame every `frameDurationMs` milliseconds.
 */
export function paceFrames(
  frames: Buffer[],
  frameDurationMs: number,
  signal: AbortSignal,
  onFrame: (frame: Buffer) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = 0;
    const send = () => {
      if (signal.aborted || i >= frames.length) {
        resolve();
        return;
      }
      onFrame(frames[i++]);
      setTimeout(send, frameDurationMs);
    };
    send();
  });
}

/**
 * Streams TTS audio for a single text chunk using the configured provider.
 * Delegates to OpenAI or ElevenLabs based on config.ttsProvider.
 */
export function streamTts(opts: {
  text: string;
  config: CheekStreamConfig;
  log: CheekStreamLog;
  outputFormat?: CheekAudioFormat;
  callbacks: CheekTtsCallbacks;
}): CheekTtsHandle {
  const provider = opts.config.ttsProvider || "openai";
  if (provider === "elevenlabs") {
    return streamElevenLabsTts(opts);
  }
  return streamOpenAiTts(opts);
}

/**
 * Streams TTS audio for a single text chunk using OpenAI TTS API.
 * Generates PCM audio, optionally encodes to Opus frames, and delivers via callbacks.
 */
function streamOpenAiTts(opts: {
  text: string;
  config: CheekStreamConfig;
  log: CheekStreamLog;
  outputFormat?: CheekAudioFormat;
  callbacks: CheekTtsCallbacks;
}): CheekTtsHandle {
  const { text, config, log, callbacks } = opts;
  const outputFormat = opts.outputFormat ?? "opus";
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
      if (outputFormat === "opus") {
        encoder = createOpusEncoder();
      }

      // Request PCM output for streaming — raw 24kHz 16-bit mono PCM
      const response = await openai.audio.speech.create({
        model,
        voice,
        input: text,
        response_format: "pcm",
      });

      if (abortController.signal.aborted) {
        encoder?.delete();
        return;
      }

      // Get the response body as an ArrayBuffer and process in PCM frame chunks
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
 * Audio frames are delivered as they're produced (Opus or raw PCM).
 */
export function createTtsPipeline(opts: {
  config: CheekStreamConfig;
  log: CheekStreamLog;
  outputFormat?: CheekAudioFormat;
  onAudioFrame: (frame: Buffer) => void;
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
  const { config, log, onAudioFrame, onComplete, onError } = opts;
  const outputFormat = opts.outputFormat ?? "opus";

  const queue: string[] = [];
  let activeTts: CheekTtsHandle | null = null;
  let finished = false;
  let aborted = false;

  function processNext() {
    if (aborted) {
      return;
    }

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
      outputFormat,
      callbacks: {
        onAudioFrame(frame) {
          if (!aborted) {
            onAudioFrame(frame);
          }
        },
        onSentenceDone() {
          activeTts = null;
          processNext();
        },
        onError(err) {
          activeTts = null;
          if (!aborted) {
            onError(err);
          }
        },
      },
    });
  }

  return {
    pushSentence(text: string) {
      if (aborted || finished) {
        return;
      }
      queue.push(text);
      // Start processing if nothing is active
      if (!activeTts) {
        processNext();
      }
    },
    finish() {
      if (aborted) {
        return;
      }
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
