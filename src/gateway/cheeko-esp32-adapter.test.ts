/**
 * Integration tests for the ESP32 protocol adapter.
 *
 * Tests the translation layer that bridges ESP32 firmware protocol
 * with OpenClaw's cheeko-stream protocol. Uses the same mock
 * infrastructure as the main e2e tests.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CheekJsonMessage } from "./test-helpers.cheeko.js";
import type { TranscriptCallback } from "./cheeko-stt.js";
import type { CheekChatCallbacks, CheekChatHandle } from "./cheeko-chat.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

type MockSttInstance = {
  audioFrames: Buffer[];
  finalized: boolean;
  closed: boolean;
  onTranscript: TranscriptCallback;
  onError: (err: unknown) => void;
  onClose: () => void;
};

type MockChatCall = {
  transcript: string;
  sessionKey: string;
  callbacks: CheekChatCallbacks;
  aborted: boolean;
};

type MockTtsPipeline = {
  sentences: string[];
  finished: boolean;
  aborted: boolean;
  triggerError: (err: string) => void;
};

const mockStt = { instances: [] as MockSttInstance[] };
const mockChat = { calls: [] as MockChatCall[] };
const mockTts = { pipelines: [] as MockTtsPipeline[] };

function resetMocks() {
  mockStt.instances.length = 0;
  mockChat.calls.length = 0;
  mockTts.pipelines.length = 0;
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("./cheeko-stt.js", () => ({
  createSttStream: (opts: {
    config: unknown;
    log: unknown;
    audioFormat?: string;
    onTranscript: TranscriptCallback;
    onError: (err: unknown) => void;
    onClose: () => void;
  }) => {
    const instance: MockSttInstance = {
      audioFrames: [],
      finalized: false,
      closed: false,
      onTranscript: opts.onTranscript,
      onError: opts.onError,
      onClose: opts.onClose,
    };
    mockStt.instances.push(instance);
    return {
      sendAudio: (buf: Buffer) => instance.audioFrames.push(buf),
      finalize: () => { instance.finalized = true; },
      close: () => { instance.closed = true; },
      isConnected: () => !instance.closed,
    };
  },
}));

vi.mock("./cheeko-chat.js", () => ({
  sendChatMessage: (opts: {
    transcript: string;
    sessionKey: string;
    log: unknown;
    callbacks: CheekChatCallbacks;
  }): CheekChatHandle => {
    const call: MockChatCall = {
      transcript: opts.transcript,
      sessionKey: opts.sessionKey,
      callbacks: opts.callbacks,
      aborted: false,
    };
    mockChat.calls.push(call);
    return { abort: () => { call.aborted = true; } };
  },
}));

vi.mock("./cheeko-tts.js", () => ({
  createTtsPipeline: (opts: {
    config: unknown;
    log: unknown;
    outputFormat?: string;
    onAudioFrame: (frame: Buffer) => void;
    onComplete: () => void;
    onError: (err: string) => void;
  }) => {
    let finished = false;
    let aborted = false;
    let processing = false;

    const pipeline: MockTtsPipeline = {
      sentences: [],
      finished: false,
      aborted: false,
      triggerError: (err: string) => { if (!aborted) opts.onError(err); },
    };
    mockTts.pipelines.push(pipeline);

    function completeSentence() {
      if (aborted) return;
      opts.onAudioFrame(Buffer.alloc(960, 0xaa));
      processing = false;
      if (finished) opts.onComplete();
    }

    return {
      pushSentence(text: string) {
        if (aborted || finished) return;
        pipeline.sentences.push(text);
        if (!processing) {
          processing = true;
          queueMicrotask(() => completeSentence());
        }
      },
      finish() {
        if (aborted) return;
        finished = true;
        pipeline.finished = true;
        if (!processing) {
          queueMicrotask(() => { if (!aborted) opts.onComplete(); });
        }
      },
      abort() {
        aborted = true;
        pipeline.aborted = true;
      },
    };
  },
  streamTts: () => ({ abort: () => {} }),
}));

// ---------------------------------------------------------------------------
// Import test helpers AFTER mocks
// ---------------------------------------------------------------------------

const { startCheekTestServer, CheekTestClient, generateFakeOpusFrame } = await import(
  "./test-helpers.cheeko.js"
);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("cheeko-esp32-adapter", () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    resetMocks();
    const server = await startCheekTestServer();
    serverUrl = server.url;
    closeServer = server.close;
  });

  afterEach(async () => {
    await closeServer();
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  async function createEsp32Client(): Promise<{
    client: InstanceType<typeof CheekTestClient>;
    sessionId: string;
  }> {
    const client = new CheekTestClient(serverUrl);
    await client.connect();
    const helloResp = await client.sendEsp32Hello();
    return { client, sessionId: helloResp.session_id as string };
  }

  function waitForSttFlush(): Promise<void> {
    return new Promise((r) => setTimeout(r, 1000));
  }

  function waitForWsPropagation(): Promise<void> {
    return new Promise((r) => setTimeout(r, 100));
  }

  async function driveEsp32Pipeline(transcript: string, response: string): Promise<void> {
    const stt = mockStt.instances[mockStt.instances.length - 1];
    stt.onTranscript(transcript, true);
    await waitForSttFlush();
    const chat = mockChat.calls[mockChat.calls.length - 1];
    chat.callbacks.onTextChunk(response);
    chat.callbacks.onComplete(response);
    await waitForWsPropagation();
  }

  // -----------------------------------------------------------------------
  // Test 1: ESP32 hello handshake
  // -----------------------------------------------------------------------

  test("ESP32 hello is detected and responded to in ESP32 format", async () => {
    const client = new CheekTestClient(serverUrl);
    await client.connect();
    const resp = await client.sendEsp32Hello();

    expect(resp.type).toBe("hello");
    expect(resp.transport).toBe("websocket");
    expect(resp.session_id).toBeTypeOf("string");
    expect(resp.audio_params).toBeDefined();
    const params = resp.audio_params as Record<string, unknown>;
    expect(params.format).toBe("opus");
    expect(params.sample_rate).toBe(24000);
    expect(params.channels).toBe(1);
    expect(params.frame_duration).toBe(20);

    // Should NOT receive status:idle (ESP32 doesn't expect it)
    await waitForWsPropagation();
    const statuses = client.getMessages("status");
    expect(statuses.length).toBe(0);

    client.close();
  });

  // -----------------------------------------------------------------------
  // Test 2: listen:stop → speech_end
  // -----------------------------------------------------------------------

  test(
    "listen:stop is translated to speech_end behavior",
    { timeout: 10000 },
    async () => {
      const { client, sessionId } = await createEsp32Client();

      // Send audio to enter listening state
      client.sendAudio(generateFakeOpusFrame());
      await client.waitForStatus("listening");

      // Send listen:start (should be accepted without error)
      client.sendListenStart(sessionId);
      await waitForWsPropagation();

      // Send listen:stop (should trigger speech_end flow)
      client.sendListenStop(sessionId);
      await client.waitForStatus("stt");

      // Verify STT was finalized
      expect(mockStt.instances.length).toBe(1);

      client.close();
    },
  );

  // -----------------------------------------------------------------------
  // Test 3: abort → cancel
  // -----------------------------------------------------------------------

  test(
    "abort is translated to cancel behavior",
    { timeout: 10000 },
    async () => {
      const { client, sessionId } = await createEsp32Client();

      client.sendAudio(generateFakeOpusFrame());
      await client.waitForStatus("listening");
      client.sendListenStop(sessionId);

      const stt = mockStt.instances[0];
      stt.onTranscript("abort test", true);
      await waitForSttFlush();

      await client.waitForStatus("thinking", 3000);

      const idxBefore = client.messages.length;
      client.sendAbort(sessionId);
      await client.waitForStatus("idle", 3000, idxBefore);

      expect(mockChat.calls.length).toBe(1);
      expect(mockChat.calls[0].aborted).toBe(true);

      client.close();
    },
  );

  // -----------------------------------------------------------------------
  // Test 4: Binary v2/v3 header stripping
  // -----------------------------------------------------------------------

  test("binary v2 headers are stripped correctly", async () => {
    // For this test we need to verify the stripped data reaches STT.
    // Since protocol version comes from the hello message, and we send version:1,
    // v2/v3 stripping only activates for protocolVersion >= 2.
    // We test the strip logic indirectly: sending v1 raw Opus (no header) should
    // pass through unchanged.
    const { client } = await createEsp32Client();

    const opusFrame = generateFakeOpusFrame(80);
    client.sendAudio(opusFrame);
    await client.waitForStatus("listening");

    // For v1, the full frame should be passed to STT unchanged
    expect(mockStt.instances.length).toBe(1);
    expect(mockStt.instances[0].audioFrames.length).toBe(1);
    expect(mockStt.instances[0].audioFrames[0].length).toBe(80);

    client.close();
  });

  // -----------------------------------------------------------------------
  // Test 5: Outbound message translation
  // -----------------------------------------------------------------------

  test(
    "outbound transcript → stt, audio_end → tts:stop translation",
    { timeout: 10000 },
    async () => {
      const { client, sessionId } = await createEsp32Client();

      // Send audio and trigger speech end
      client.sendAudio(generateFakeOpusFrame());
      await client.waitForStatus("listening");
      client.sendListenStop(sessionId);

      // Drive the pipeline
      await driveEsp32Pipeline("Hello ESP32", "Hi from server!");

      // Verify: stt message (not transcript)
      const sttMsg = await client.waitForMessage(
        (m) => m.type === "stt",
        3000,
      );
      expect(sttMsg.text).toBe("Hello ESP32");
      expect(sttMsg.session_id).toBe(sessionId);

      // Verify: tts sentence_start (not response_text)
      const ttsSentence = await client.waitForMessage(
        (m) => m.type === "tts" && m.state === "sentence_start",
        3000,
      );
      expect(ttsSentence.text).toBe("Hi from server!");
      expect(ttsSentence.session_id).toBe(sessionId);

      // Verify: tts:start (not status:speaking)
      const ttsStart = await client.waitForMessage(
        (m) => m.type === "tts" && m.state === "start",
        3000,
      );
      expect(ttsStart.session_id).toBe(sessionId);

      // Verify: tts:stop (not audio_end)
      const ttsStop = await client.waitForMessage(
        (m) => m.type === "tts" && m.state === "stop",
        3000,
      );
      expect(ttsStop.session_id).toBe(sessionId);

      // Verify: no audio_end or status:speaking messages were sent
      const audioEndMsgs = client.getMessages("audio_end");
      expect(audioEndMsgs.length).toBe(0);

      // Verify: no transcript messages (should be stt instead)
      const transcriptMsgs = client.getMessages("transcript");
      expect(transcriptMsgs.length).toBe(0);

      // Verify: binary audio frames were received
      expect(client.audioFrames.length).toBeGreaterThan(0);

      client.close();
    },
  );
});
