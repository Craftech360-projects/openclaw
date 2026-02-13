/**
 * Live end-to-end tests for the Cheeko voice pipeline.
 *
 * These tests use real Deepgram STT, real LLM (via gateway config), and real
 * TTS (OpenAI or ElevenLabs). They require a **running gateway** because
 * `sendChatMessage` calls `loadConfig()`, `dispatchInboundMessage()`, and the
 * full agent runtime.
 *
 * Prerequisites:
 *   1. Start the gateway:  pnpm start (or however you normally start it)
 *   2. Ensure gateway config has `gateway.cheeko` section with Deepgram + TTS keys
 *   3. Set env vars:
 *        DEEPGRAM_API_KEY  — for STT
 *        OPENAI_API_KEY or ELEVENLABS_API_KEY — for TTS
 *   4. Optionally set CHEEKO_LIVE_URL to override the WebSocket endpoint
 *      (defaults to ws://127.0.0.1:18789/cheeko/stream)
 *
 * Run with:
 *   pnpm vitest run src/gateway/cheeko-stream.live.test.ts --config vitest.live.config.ts
 */

import { describe, expect, test } from "vitest";
import {
  CheekTestClient,
  loadTestWavPcm,
  resamplePcm,
  splitPcmIntoFrames,
} from "./test-helpers.cheeko.js";

// ---------------------------------------------------------------------------
// Gate: skip if required API keys are missing
// ---------------------------------------------------------------------------

const HAS_DEEPGRAM = !!process.env.DEEPGRAM_API_KEY;
const HAS_TTS = !!(process.env.OPENAI_API_KEY || process.env.ELEVENLABS_API_KEY);
const HAS_KEYS = HAS_DEEPGRAM && HAS_TTS;

const describeLive = HAS_KEYS ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Gateway WebSocket URL
// ---------------------------------------------------------------------------

const CHEEKO_URL =
  process.env.CHEEKO_LIVE_URL || "ws://127.0.0.1:18789/cheeko/stream";

// ---------------------------------------------------------------------------
// Audio preparation
// ---------------------------------------------------------------------------

function prepareTestAudio(): Buffer[] {
  const { pcmData, sampleRate } = loadTestWavPcm();
  // Resample from 48kHz to 16kHz for Deepgram
  const pcm16k = resamplePcm(pcmData, sampleRate, 16000);
  // Split into 20ms frames
  return splitPcmIntoFrames(pcm16k, 20, 16000);
}

// ---------------------------------------------------------------------------
// Live test suite
// ---------------------------------------------------------------------------

describeLive("cheeko-stream live", () => {
  test(
    "full pipeline with real audio: STT → LLM → TTS → audio back",
    { timeout: 90_000 },
    async () => {
      const client = new CheekTestClient(CHEEKO_URL);

      try {
        await client.connect();
        await client.sendHello({ deviceId: "live-test", clientType: "web" });

        // Send real audio frames
        const frames = prepareTestAudio();
        for (const frame of frames) {
          client.sendAudio(frame);
        }

        // Signal end of speech
        client.sendSpeechEnd();

        // Wait for transcript
        const transcript = await client.waitForMessage(
          (m) => m.type === "transcript" && m.partial === false,
          15000,
        );
        expect(transcript.text).toBeTypeOf("string");
        expect((transcript.text as string).length).toBeGreaterThan(0);
        console.log(`[live] STT transcript: "${transcript.text}"`);

        // Wait for LLM response
        const responseText = await client.waitForMessage(
          (m) => m.type === "response_text" && m.partial === false,
          45000,
        );
        expect(responseText.text).toBeTypeOf("string");
        console.log(
          `[live] LLM response (${(responseText.text as string).length} chars): "${(responseText.text as string).slice(0, 100)}..."`,
        );

        // Wait for audio to finish
        await client.waitForMessage((m) => m.type === "audio_end", 30000);

        // Verify we got audio frames back
        expect(client.audioFrames.length).toBeGreaterThan(0);
        const totalAudioBytes = client.audioFrames.reduce((sum, f) => sum + f.length, 0);
        console.log(
          `[live] Received ${client.audioFrames.length} audio frames (${totalAudioBytes} bytes)`,
        );
      } finally {
        client.close();
      }
    },
  );

  test(
    "latency benchmark",
    { timeout: 90_000 },
    async () => {
      const client = new CheekTestClient(CHEEKO_URL);

      try {
        await client.connect();
        await client.sendHello({ deviceId: "latency-test", clientType: "web" });

        const frames = prepareTestAudio();
        for (const frame of frames) {
          client.sendAudio(frame);
        }

        const sendTime = Date.now();
        client.sendSpeechEnd();

        // Wait for latency message from server
        const latencyMsg = await client.waitForMessage((m) => m.type === "latency", 45000);
        const clientLatency = Date.now() - sendTime;

        const serverLatency = latencyMsg.speechEndToFirstAudio as number;
        console.log(`[live] Server-reported latency (speech_end → first audio): ${serverLatency}ms`);
        console.log(`[live] Client-measured latency (speech_end → latency msg): ${clientLatency}ms`);

        // Generous bound — should be under 15s even with slow APIs
        expect(serverLatency).toBeGreaterThan(0);
        expect(serverLatency).toBeLessThan(15000);

        // Wait for pipeline to complete
        await client.waitForMessage((m) => m.type === "audio_end", 30000);
      } finally {
        client.close();
      }
    },
  );

  test(
    "audio quality validation",
    { timeout: 90_000 },
    async () => {
      const client = new CheekTestClient(CHEEKO_URL);

      try {
        await client.connect();
        // Use PCM output for easier validation
        await client.sendHello({ deviceId: "quality-test", clientType: "web" });

        const frames = prepareTestAudio();
        for (const frame of frames) {
          client.sendAudio(frame);
        }
        client.sendSpeechEnd();

        // Wait for audio to complete
        await client.waitForMessage((m) => m.type === "audio_end", 60000);

        // Validate audio frames
        expect(client.audioFrames.length).toBeGreaterThan(0);

        for (const frame of client.audioFrames) {
          // Each frame should be non-empty
          expect(frame.length).toBeGreaterThan(0);
          // PCM frames should have even byte count (16-bit samples)
          expect(frame.length % 2).toBe(0);
        }

        const totalBytes = client.audioFrames.reduce((sum, f) => sum + f.length, 0);
        console.log(
          `[live] Audio quality: ${client.audioFrames.length} frames, ` +
            `${totalBytes} total bytes, ` +
            `avg frame size: ${Math.round(totalBytes / client.audioFrames.length)} bytes`,
        );

        // Total audio should be at least a few KB (non-trivial response)
        expect(totalBytes).toBeGreaterThan(1000);
      } finally {
        client.close();
      }
    },
  );
});
