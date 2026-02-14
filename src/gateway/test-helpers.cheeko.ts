/**
 * Test helpers for the Cheeko voice pipeline.
 *
 * Provides a minimal HTTP server that mounts only the cheeko WebSocket handler
 * (no full gateway boot), a protocol-aware WebSocket test client, and audio helpers.
 */

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { createCheekStreamHandler, CHEEKO_STREAM_PATH } from "./cheeko-stream.js";
import type { CheekStreamConfig } from "../config/types.gateway.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheekJsonMessage = Record<string, unknown> & { type: string };

// ---------------------------------------------------------------------------
// Minimal test server
// ---------------------------------------------------------------------------

export async function startCheekTestServer(config?: Partial<CheekStreamConfig>): Promise<{
  port: number;
  url: string;
  httpServer: Server;
  close: () => Promise<void>;
}> {
  const cheekConfig: CheekStreamConfig = { enabled: true, ...config };

  const cheeko = createCheekStreamHandler({
    getConfig: () => cheekConfig,
    log: { info: () => {}, warn: () => {} },
  });

  const httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  httpServer.on("upgrade", (req, socket, head) => {
    if (!cheeko.handleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind"));
        return;
      }
      resolve(addr.port);
    });
    httpServer.once("error", reject);
  });

  const url = `ws://127.0.0.1:${port}${CHEEKO_STREAM_PATH}`;

  return {
    port,
    url,
    httpServer,
    close: async () => {
      cheeko.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// WebSocket test client
// ---------------------------------------------------------------------------

export class CheekTestClient {
  private ws: WebSocket | null = null;
  private readonly _url: string;

  /** All received JSON messages (parsed). */
  readonly messages: CheekJsonMessage[] = [];

  /** All received binary audio frames. */
  readonly audioFrames: Buffer[] = [];

  /** Pending waiters registered via waitForMessage(). */
  private readonly _waiters: Array<{
    filter: (msg: CheekJsonMessage) => boolean;
    resolve: (msg: CheekJsonMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  /** Pending binary waiters registered via waitForBinary(). */
  private readonly _binaryWaiters: Array<{
    resolve: (frame: Buffer) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(url: string) {
    this._url = url;
  }

  // -- Connection -----------------------------------------------------------

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this._url);
      this.ws.binaryType = "nodebuffer";

      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));

      this.ws.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
          this.audioFrames.push(buf);
          // Resolve pending binary waiters
          const waiter = this._binaryWaiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(buf);
          }
          return;
        }
        const text = typeof data === "string" ? data : data.toString("utf-8");
        try {
          const msg = JSON.parse(text) as CheekJsonMessage;
          this.messages.push(msg);
          // Check pending waiters
          for (let i = this._waiters.length - 1; i >= 0; i--) {
            const waiter = this._waiters[i];
            if (waiter.filter(msg)) {
              this._waiters.splice(i, 1);
              clearTimeout(waiter.timer);
              waiter.resolve(msg);
            }
          }
        } catch {
          // Ignore non-JSON text
        }
      });
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // Reject remaining waiters
    for (const w of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("client closed"));
    }
    this._waiters.length = 0;
    for (const w of this._binaryWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error("client closed"));
    }
    this._binaryWaiters.length = 0;
  }

  // -- Protocol actions -----------------------------------------------------

  /** Send hello and wait for hello_ack. */
  async sendHello(opts?: { deviceId?: string; clientType?: string }): Promise<CheekJsonMessage> {
    const hello: Record<string, unknown> = { type: "hello" };
    if (opts?.deviceId) hello.deviceId = opts.deviceId;
    if (opts?.clientType) hello.clientType = opts.clientType;
    this._send(JSON.stringify(hello));
    return this.waitForMessage((m) => m.type === "hello_ack");
  }

  /** Send ESP32-format hello and wait for ESP32-format hello response. */
  async sendEsp32Hello(): Promise<CheekJsonMessage> {
    this._send(JSON.stringify({
      type: "hello",
      version: 1,
      transport: "websocket",
      audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 20 },
      features: {},
    }));
    return this.waitForMessage((m) => m.type === "hello" && m.transport === "websocket");
  }

  /** Send ESP32 listen:start message. */
  sendListenStart(sessionId: string, mode = "manual"): void {
    this._send(JSON.stringify({ session_id: sessionId, type: "listen", state: "start", mode }));
  }

  /** Send ESP32 listen:stop message. */
  sendListenStop(sessionId: string): void {
    this._send(JSON.stringify({ session_id: sessionId, type: "listen", state: "stop" }));
  }

  /** Send ESP32 abort message. */
  sendAbort(sessionId: string, reason = "user_cancel"): void {
    this._send(JSON.stringify({ session_id: sessionId, type: "abort", reason }));
  }

  /** Send a binary audio frame. */
  sendAudio(frame: Buffer): void {
    this._send(frame);
  }

  /** Send speech_end control message. */
  sendSpeechEnd(): void {
    this._send(JSON.stringify({ type: "speech_end" }));
  }

  /** Send cancel control message. */
  sendCancel(): void {
    this._send(JSON.stringify({ type: "cancel" }));
  }

  /** Send a raw text message. */
  sendRaw(text: string): void {
    this._send(text);
  }

  // -- Message waiting ------------------------------------------------------

  /** Wait for a JSON message matching the filter.
   *  @param startIndex Only consider messages at this index or later (avoids stale matches). */
  waitForMessage(
    filter: (msg: CheekJsonMessage) => boolean,
    timeoutMs = 5000,
    startIndex = 0,
  ): Promise<CheekJsonMessage> {
    // Check already-received messages (from startIndex onward)
    for (let i = startIndex; i < this.messages.length; i++) {
      if (filter(this.messages[i])) return Promise.resolve(this.messages[i]);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new Error(`waitForMessage timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this._waiters.push({ filter, resolve, reject, timer });
    });
  }

  /** Wait for a status message with a specific stage.
   *  @param startIndex Only consider messages at this index or later. */
  waitForStatus(stage: string, timeoutMs = 5000, startIndex = 0): Promise<CheekJsonMessage> {
    return this.waitForMessage((m) => m.type === "status" && m.stage === stage, timeoutMs, startIndex);
  }

  /** Wait for an error message. */
  waitForError(timeoutMs = 5000): Promise<CheekJsonMessage> {
    return this.waitForMessage((m) => m.type === "error", timeoutMs);
  }

  /** Wait for a single binary frame. */
  waitForBinary(timeoutMs = 5000): Promise<Buffer> {
    // Check already-received frames that haven't been consumed
    // (We only return NEW frames after this call)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._binaryWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this._binaryWaiters.splice(idx, 1);
        reject(new Error(`waitForBinary timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this._binaryWaiters.push({ resolve, reject, timer });
    });
  }

  /** Wait for the WebSocket to close. */
  waitForClose(timeoutMs = 15000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve({ code: 0, reason: "" });
        return;
      }
      const timer = setTimeout(() => reject(new Error("waitForClose timeout")), timeoutMs);
      this.ws.once("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason?.toString() ?? "" });
      });
    });
  }

  /** Get all messages of a specific type. */
  getMessages(type: string): CheekJsonMessage[] {
    return this.messages.filter((m) => m.type === type);
  }

  // -- Internals ------------------------------------------------------------

  private _send(data: string | Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(data);
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Generate fake PCM silence (16-bit, mono). */
export function generateFakePcmAudio(durationMs = 100, sampleRate = 16000): Buffer {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return Buffer.alloc(samples * 2); // 16-bit = 2 bytes per sample, all zeros = silence
}

/** Generate a single fake Opus frame (just random-ish bytes, not valid Opus). */
export function generateFakeOpusFrame(size = 80): Buffer {
  const buf = Buffer.alloc(size);
  // Fill with a recognizable pattern so we can verify it was received
  for (let i = 0; i < size; i++) {
    buf[i] = (i * 7 + 0x42) & 0xff;
  }
  return buf;
}

/**
 * Load the test WAV fixture and return raw PCM data (skipping WAV header).
 * The fixture is PCM 16-bit mono 48kHz.
 */
export function loadTestWavPcm(): { pcmData: Buffer; sampleRate: number; channels: number } {
  const wavPath = resolve(import.meta.dirname, "../../test/fixtures/cheeko-test-audio.wav");
  const wav = readFileSync(wavPath);
  // Standard WAV header is 44 bytes
  const pcmData = wav.subarray(44);
  return { pcmData, sampleRate: 48000, channels: 1 };
}

/**
 * Naive PCM resampler (integer ratio only).
 * Drops or duplicates samples. Good enough for test audio.
 */
export function resamplePcm(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;
  const ratio = fromRate / toRate;
  const inputSamples = pcm.length / 2; // 16-bit
  const outputSamples = Math.floor(inputSamples / ratio);
  const out = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcIdx = Math.floor(i * ratio);
    out.writeInt16LE(pcm.readInt16LE(srcIdx * 2), i * 2);
  }
  return out;
}

/**
 * Split a PCM buffer into frames of a given duration.
 * Returns an array of Buffer frames.
 */
export function splitPcmIntoFrames(
  pcm: Buffer,
  frameDurationMs = 20,
  sampleRate = 16000,
): Buffer[] {
  const frameBytes = Math.floor((sampleRate * frameDurationMs * 2) / 1000); // 16-bit = *2
  const frames: Buffer[] = [];
  for (let offset = 0; offset + frameBytes <= pcm.length; offset += frameBytes) {
    frames.push(pcm.subarray(offset, offset + frameBytes));
  }
  return frames;
}
