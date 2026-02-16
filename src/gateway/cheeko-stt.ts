import type { ListenLiveClient } from "@deepgram/sdk";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { CheekStreamConfig } from "../config/types.gateway.js";
import type { CheekAudioFormat, CheekStreamLog } from "./cheeko-stream.js";

export type TranscriptCallback = (text: string, isFinal: boolean) => void;

export type CheekSttStream = {
  /** Send an Opus audio frame to Deepgram. */
  sendAudio: (opusFrame: Buffer) => void;
  /** Flush buffered audio and finalize the current utterance. */
  finalize: () => void;
  /** Close the Deepgram connection and clean up. */
  close: () => void;
  /** Whether the Deepgram connection is open and ready. */
  isConnected: () => boolean;
  /** Send a keep-alive ping to prevent Deepgram from closing the connection. */
  keepAlive: () => void;
};

/**
 * Opens a streaming STT connection to Deepgram Nova-2.
 * Opus frames are sent directly (Deepgram supports opus encoding natively).
 */
export function createSttStream(opts: {
  config: CheekStreamConfig;
  log: CheekStreamLog;
  audioFormat?: CheekAudioFormat;
  onTranscript: TranscriptCallback;
  onError: (err: unknown) => void;
  onClose: () => void;
}): CheekSttStream {
  const { config, log, onTranscript, onError, onClose } = opts;
  const audioFormat = opts.audioFormat ?? "opus";

  const apiKey = config.deepgramApiKey || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("Deepgram API key not configured");
  }

  const model = config.deepgramModel || "nova-2";

  const deepgram = createClient(apiKey);

  // PCM web clients send 16kHz 16-bit mono linear PCM; native clients send Opus
  const dgEncoding = audioFormat === "pcm" ? "linear16" : "opus";
  log.info(`cheeko-stt: opening Deepgram connection (encoding: ${dgEncoding})`);

  const connection: ListenLiveClient = deepgram.listen.live({
    model,
    language: "en",
    encoding: dgEncoding,
    sample_rate: 16000,
    channels: 1,
    punctuate: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000,
    vad_events: true,
    smart_format: true,
  });

  let closed = false;
  let ready = false;
  const pendingFrames: (ArrayBuffer | SharedArrayBuffer)[] = [];
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  connection.on(LiveTranscriptionEvents.Open, () => {
    log.info("cheeko-stt: Deepgram connection opened");
    ready = true;
    // Flush any audio frames that arrived before the connection was ready
    for (const frame of pendingFrames) {
      connection.send(frame);
    }
    pendingFrames.length = 0;

    // Send keepAlive every 3s for the lifetime of the connection
    // Prevents Deepgram from closing when ESP32 VAD pauses audio
    keepAliveInterval = setInterval(() => {
      if (closed) {
        if (keepAliveInterval) {
          clearInterval(keepAliveInterval);
          keepAliveInterval = null;
        }
        return;
      }
      try {
        connection.keepAlive();
      } catch {
        // ignore
      }
    }, 3000);
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    const transcript: string = data?.channel?.alternatives?.[0]?.transcript ?? "";
    if (!transcript) {
      return;
    }

    const isFinal: boolean = !!data.is_final;
    onTranscript(transcript, isFinal);
  });

  connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    log.info("cheeko-stt: utterance end detected");
  });

  connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
    log.info("cheeko-stt: speech started");
  });

  connection.on(LiveTranscriptionEvents.Error, (err: any) => {
    log.warn(`cheeko-stt: Deepgram error: ${String(err?.message || err)}`);
    onError(err);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    log.info("cheeko-stt: Deepgram connection closed");
    closed = true;
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    onClose();
  });

  return {
    sendAudio(opusFrame: Buffer) {
      if (closed) {
        return;
      }
      const ab = opusFrame.buffer.slice(
        opusFrame.byteOffset,
        opusFrame.byteOffset + opusFrame.byteLength,
      );
      if (ready) {
        connection.send(ab);
      } else {
        // Buffer frames until the WebSocket connection is open
        pendingFrames.push(ab);
      }
    },

    finalize() {
      if (closed || !ready) {
        return;
      }
      connection.finalize();
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }
      try {
        connection.requestClose();
      } catch {
        // ignore close errors
      }
    },

    isConnected() {
      return !closed && connection.isConnected();
    },

    keepAlive() {
      if (closed || !ready) {
        return;
      }
      try {
        connection.keepAlive();
      } catch {
        // ignore keepAlive errors
      }
    },
  };
}
