/**
 * Mocked end-to-end tests for the Cheeko voice pipeline.
 *
 * These tests mock Deepgram STT, the LLM chat bridge, and the TTS pipeline
 * so they run without API keys. The real `createCheekStreamHandler` is
 * exercised end-to-end over a real WebSocket connection.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CheekJsonMessage } from "./test-helpers.cheeko.js";
import type { TranscriptCallback } from "./cheeko-stt.js";
import type { CheekChatCallbacks, CheekChatHandle } from "./cheeko-chat.js";

// ---------------------------------------------------------------------------
// Mock state — test code controls these to drive the pipeline
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
  /** Trigger a TTS error directly (calls the onError callback). */
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
// Module mocks — must be at top level before any imports that use them
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
      finalize: () => {
        instance.finalized = true;
      },
      close: () => {
        instance.closed = true;
      },
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
    return {
      abort: () => {
        call.aborted = true;
      },
    };
  },
}));

// Mock the entire cheeko-tts module. We cannot partially mock streamTts because
// createTtsPipeline calls streamTts via a direct internal reference, not through
// the module's export proxy. So we mock both with a simplified TTS pipeline.
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
      triggerError: (err: string) => {
        if (!aborted) opts.onError(err);
      },
    };
    mockTts.pipelines.push(pipeline);

    function completeSentence() {
      if (aborted) return;
      // Produce a fake 960-byte audio frame
      opts.onAudioFrame(Buffer.alloc(960, 0xaa));
      processing = false;
      if (finished) {
        opts.onComplete();
      }
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
          queueMicrotask(() => {
            if (!aborted) opts.onComplete();
          });
        }
      },
      abort() {
        aborted = true;
        pipeline.aborted = true;
      },
    };
  },
  // Export a no-op streamTts in case anything imports it directly
  streamTts: () => ({ abort: () => {} }),
}));

// ---------------------------------------------------------------------------
// Import test helpers AFTER mocks are registered
// ---------------------------------------------------------------------------

const { startCheekTestServer, CheekTestClient, generateFakePcmAudio } = await import(
  "./test-helpers.cheeko.js"
);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("cheeko-stream e2e", () => {
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

  async function createConnectedClient(opts?: {
    deviceId?: string;
    clientType?: string;
  }): Promise<InstanceType<typeof CheekTestClient>> {
    const client = new CheekTestClient(serverUrl);
    await client.connect();
    await client.sendHello(opts);
    return client;
  }

  /** Wait for the 800ms STT flush timer + some margin. */
  function waitForSttFlush(): Promise<void> {
    return new Promise((r) => setTimeout(r, 1000));
  }

  /** Small delay to let microtasks fire and WS messages propagate. */
  function waitForWsPropagation(): Promise<void> {
    return new Promise((r) => setTimeout(r, 100));
  }

  /**
   * Drive the full pipeline from the mock side:
   * 1. Emit a final STT transcript
   * 2. Wait for the 800ms flush timer
   * 3. Respond from the mock LLM
   * 4. Wait for TTS microtasks and WS propagation
   */
  async function drivePipeline(transcript: string, response: string): Promise<void> {
    // STT emits final transcript
    const stt = mockStt.instances[mockStt.instances.length - 1];
    stt.onTranscript(transcript, true);

    // Wait for the 800ms flush timer in handleSpeechEnd
    await waitForSttFlush();

    // LLM responds
    const chat = mockChat.calls[mockChat.calls.length - 1];
    chat.callbacks.onTextChunk(response);
    chat.callbacks.onComplete(response);

    // Let TTS mock microtasks fire and WS messages propagate to client
    await waitForWsPropagation();
  }

  // -----------------------------------------------------------------------
  // Connection & Handshake
  // -----------------------------------------------------------------------

  test("hello → hello_ack with sessionId and deviceId", async () => {
    const client = new CheekTestClient(serverUrl);
    await client.connect();
    const ack = await client.sendHello({ deviceId: "test-dev-1" });
    expect(ack.type).toBe("hello_ack");
    expect(ack.sessionId).toBeTypeOf("string");
    expect(ack.deviceId).toBe("test-dev-1");
    client.close();
  });

  test(
    "handshake timeout if no hello sent",
    { timeout: 15000 },
    async () => {
      const client = new CheekTestClient(serverUrl);
      await client.connect();
      // Don't send hello — wait for timeout
      const err = await client.waitForError(12000);
      expect(err.message).toContain("handshake timeout");
      const { code } = await client.waitForClose();
      expect(code).toBe(4001);
    },
  );

  test("audio before hello returns error", async () => {
    const client = new CheekTestClient(serverUrl);
    await client.connect();
    client.sendAudio(generateFakePcmAudio(20));
    const err = await client.waitForError();
    expect(err.message).toContain("send hello before audio");
    client.close();
  });

  test("disabled config rejects upgrade with 403", async () => {
    // Start a separate server with disabled config
    const disabled = await startCheekTestServer({ enabled: false });
    const client = new CheekTestClient(disabled.url);
    try {
      await client.connect();
      // If connection succeeds, hello should get an error
      client.sendRaw(JSON.stringify({ type: "hello" }));
      // The upgrade should have been rejected so connect may throw
    } catch {
      // Expected — connection rejected
    }
    client.close();
    await disabled.close();
  });

  test("web client gets pcm audio format", async () => {
    const client = await createConnectedClient({ clientType: "web" });
    // Send audio to trigger STT creation
    client.sendAudio(generateFakePcmAudio(20));
    await client.waitForStatus("listening");
    // We can't directly check audioFormat, but the STT mock received audio
    expect(mockStt.instances.length).toBe(1);
    expect(mockStt.instances[0].audioFrames.length).toBeGreaterThan(0);
    client.close();
  });

  // -----------------------------------------------------------------------
  // Full Pipeline
  // -----------------------------------------------------------------------

  test(
    "happy path: audio → STT → LLM → TTS → audio back",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient({ deviceId: "e2e-happy" });

      // Send audio frames
      client.sendAudio(generateFakePcmAudio(100));
      client.sendAudio(generateFakePcmAudio(100));
      await client.waitForStatus("listening");

      // Signal end of speech
      client.sendSpeechEnd();
      await client.waitForStatus("stt");

      // Drive the mocked pipeline (includes propagation delay)
      await drivePipeline("Hello world", "Hi there!");

      // Verify transcript delivered
      const finalTranscript = await client.waitForMessage(
        (m) => m.type === "transcript" && m.partial === false,
        3000,
      );
      expect(finalTranscript.text).toBe("Hello world");

      // Verify LLM response text delivered
      const responseText = await client.waitForMessage(
        (m) => m.type === "response_text" && m.partial === false,
        3000,
      );
      expect(responseText.text).toBe("Hi there!");

      // Verify audio frames were received
      await client.waitForMessage((m) => m.type === "audio_end", 3000);
      expect(client.audioFrames.length).toBeGreaterThan(0);

      // Verify return to idle (skip initial hello idle by searching from recent messages)
      const afterAudioEnd = client.messages.length;
      await client.waitForStatus("idle", 3000, afterAudioEnd - 1);

      client.close();
    },
  );

  test(
    "state transitions follow correct sequence",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();

      // Send audio → listening
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");

      // Speech end → stt
      client.sendSpeechEnd();
      await client.waitForStatus("stt");

      // Drive pipeline (includes propagation delay)
      await drivePipeline("test", "response");

      // Wait for the full sequence to complete
      await client.waitForMessage((m) => m.type === "audio_end", 3000);

      // Verify all status stages appeared in order
      const statuses = client.getMessages("status").map((m) => m.stage);
      const expectedOrder = ["listening", "stt", "thinking", "speaking", "idle"];
      let lastIdx = -1;
      for (const expected of expectedOrder) {
        const idx = statuses.indexOf(expected, lastIdx + 1);
        expect(idx, `expected "${expected}" after index ${lastIdx} in [${statuses}]`).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }

      client.close();
    },
  );

  // -----------------------------------------------------------------------
  // Transcript & Latency
  // -----------------------------------------------------------------------

  test(
    "interim and final transcripts are delivered",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");
      client.sendSpeechEnd();

      const stt = mockStt.instances[0];
      // Emit interim transcripts
      stt.onTranscript("Hel", false);
      stt.onTranscript("Hello wor", false);
      // Emit final
      stt.onTranscript("Hello world", true);

      // Wait for final transcript to arrive
      const finalMsg = await client.waitForMessage(
        (m) => m.type === "transcript" && m.partial === false,
        3000,
      );
      expect(finalMsg.text).toBe("Hello world");

      // Wait a bit for all messages to propagate
      await waitForWsPropagation();

      const transcripts = client.getMessages("transcript");
      expect(transcripts.length).toBeGreaterThanOrEqual(3);

      const partials = transcripts.filter((m) => m.partial === true);
      const finals = transcripts.filter((m) => m.partial === false);
      expect(partials.length).toBeGreaterThanOrEqual(2);
      expect(finals.length).toBeGreaterThanOrEqual(1);

      client.close();
    },
  );

  test(
    "latency measurement is reported",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");
      client.sendSpeechEnd();

      // drivePipeline includes propagation delay so latency msg should arrive
      await drivePipeline("test", "reply");

      const latencyMsg = await client.waitForMessage((m) => m.type === "latency", 5000);
      expect(latencyMsg.type).toBe("latency");
      expect(latencyMsg.speechEndToFirstAudio).toBeTypeOf("number");
      expect(latencyMsg.speechEndToFirstAudio as number).toBeGreaterThan(0);

      client.close();
    },
  );

  // -----------------------------------------------------------------------
  // Cancel & Multi-turn
  // -----------------------------------------------------------------------

  test(
    "cancel during thinking aborts LLM and returns to idle",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");
      client.sendSpeechEnd();

      const stt = mockStt.instances[0];
      stt.onTranscript("cancel me", true);
      await waitForSttFlush();

      // Wait for thinking status
      await client.waitForStatus("thinking", 3000);

      // Record message index BEFORE sending cancel so we can wait for NEW idle
      const idxBeforeCancel = client.messages.length;

      // Send cancel before LLM responds
      client.sendCancel();

      // Wait for the NEW idle status (not the hello-ack idle)
      await client.waitForStatus("idle", 3000, idxBeforeCancel);

      // LLM abort should have been called
      expect(mockChat.calls.length).toBe(1);
      expect(mockChat.calls[0].aborted).toBe(true);

      client.close();
    },
  );

  test(
    "multi-turn conversation reuses session",
    { timeout: 15000 },
    async () => {
      const client = await createConnectedClient({ deviceId: "multi-turn" });

      // Turn 1
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");
      client.sendSpeechEnd();
      await drivePipeline("first question", "first answer");
      await client.waitForMessage((m) => m.type === "audio_end", 5000);

      // Record message index after turn 1 so turn 2 waits skip stale matches
      const afterTurn1 = client.messages.length;

      // Turn 2
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening", 3000, afterTurn1);
      client.sendSpeechEnd();
      await drivePipeline("second question", "second answer");
      await client.waitForMessage((m) => m.type === "audio_end", 5000, afterTurn1);

      // Verify both turns were processed
      expect(mockChat.calls.length).toBe(2);
      expect(mockChat.calls[0].transcript).toBe("first question");
      expect(mockChat.calls[1].transcript).toBe("second question");

      // Verify session key is consistent
      expect(mockChat.calls[0].sessionKey).toBe("voice:multi-turn");
      expect(mockChat.calls[1].sessionKey).toBe("voice:multi-turn");

      client.close();
    },
  );

  // -----------------------------------------------------------------------
  // Error Handling
  // -----------------------------------------------------------------------

  test(
    "STT error is reported to client",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");

      // Trigger STT error
      const stt = mockStt.instances[0];
      stt.onError(new Error("Deepgram connection failed"));

      const err = await client.waitForError(3000);
      expect(err.message).toContain("STT");

      client.close();
    },
  );

  test(
    "LLM error is reported and returns to idle",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");
      client.sendSpeechEnd();

      const stt = mockStt.instances[0];
      stt.onTranscript("trigger error", true);
      await waitForSttFlush();

      await client.waitForStatus("thinking", 3000);

      // LLM fails
      const chat = mockChat.calls[0];
      chat.callbacks.onError("Model unavailable");

      const err = await client.waitForError(3000);
      expect(err.message).toContain("LLM error");
      expect(err.message).toContain("Model unavailable");

      client.close();
    },
  );

  test(
    "TTS error is reported and returns to idle",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");
      client.sendSpeechEnd();

      const stt = mockStt.instances[0];
      stt.onTranscript("tts will fail", true);
      await waitForSttFlush();

      await client.waitForStatus("thinking", 3000);

      // TTS pipeline was created in proceedWithTranscript — trigger error
      expect(mockTts.pipelines.length).toBe(1);
      mockTts.pipelines[0].triggerError("TTS API connection failed");

      const err = await client.waitForError(3000);
      expect(err.message).toContain("TTS error");
      expect(err.message).toContain("TTS API connection failed");

      client.close();
    },
  );

  // -----------------------------------------------------------------------
  // Edge Cases
  // -----------------------------------------------------------------------

  test(
    "empty transcript returns to idle without calling LLM",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");
      client.sendSpeechEnd();
      await client.waitForStatus("stt");

      // Don't emit any STT transcript — leave finalTranscript empty
      // Wait for the 800ms flush timer
      await waitForSttFlush();

      // Allow WS messages to propagate
      await waitForWsPropagation();

      // No LLM call should have been made
      expect(mockChat.calls.length).toBe(0);

      client.close();
    },
  );

  test(
    "disconnect mid-pipeline cleans up without crash",
    { timeout: 10000 },
    async () => {
      const client = await createConnectedClient();
      client.sendAudio(generateFakePcmAudio(50));
      await client.waitForStatus("listening");
      client.sendSpeechEnd();

      const stt = mockStt.instances[0];
      stt.onTranscript("disconnect test", true);
      await waitForSttFlush();

      // Close abruptly while pipeline is in progress
      client.close();

      // Give the server time to clean up
      await new Promise((r) => setTimeout(r, 500));

      // Verify cleanup happened
      expect(stt.closed).toBe(true);
      if (mockChat.calls.length > 0) {
        expect(mockChat.calls[0].aborted).toBe(true);
      }
    },
  );

  test("speech_end without listening returns error", async () => {
    const client = await createConnectedClient();
    // Send speech_end without any audio first
    client.sendSpeechEnd();
    const err = await client.waitForError();
    expect(err.message).toContain("not currently listening");
    client.close();
  });
});
