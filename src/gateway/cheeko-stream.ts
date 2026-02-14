import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { CheekStreamConfig } from "../config/types.gateway.js";
import { createSttStream, type CheekSttStream } from "./cheeko-stt.js";
import { sendChatMessage, type CheekChatHandle } from "./cheeko-chat.js";
import { createTtsPipeline } from "./cheeko-tts.js";

export const CHEEKO_STREAM_PATH = "/cheeko/stream";

/** Audio format negotiated per connection. */
export type CheekAudioFormat = "opus" | "pcm";

/** Per-connection session state. */
export type CheekStreamSession = {
  sessionId: string;
  deviceId: string;
  ws: WebSocket;
  state: "idle" | "listening" | "processing" | "speaking";
  chatHistory: Array<{ role: string; content: string }>;
  createdAt: number;
  /** Audio format for this session (opus for native clients, pcm for web). */
  audioFormat: CheekAudioFormat;
  /** Active Deepgram STT stream (created on first audio chunk). */
  sttStream: CheekSttStream | null;
  /** Accumulated final transcript segments for the current utterance. */
  finalTranscript: string;
  /** Active LLM chat handle (for abort support). */
  chatHandle: CheekChatHandle | null;
  /** Active TTS pipeline (for streaming audio back). */
  ttsPipeline: ReturnType<typeof createTtsPipeline> | null;
  /** Timestamp (ms) when speech_end was received — for latency measurement. */
  speechEndAt: number;
  /** Whether the first audio frame for the current response has been sent. */
  firstAudioSent: boolean;
  /** Whether this client is an ESP32 device (detected from hello message format). */
  isEsp32Client: boolean;
  /** ESP32 binary protocol version: 1 (raw Opus), 2, or 3. */
  protocolVersion: number;
  /** ESP32 listening mode: "auto" | "manual" | "realtime". */
  esp32ListeningMode: string;
};

export type CheekStreamLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
};

type ControlMessage =
  | { type: "hello"; deviceId?: string; token?: string; clientType?: string;
      transport?: string; audio_params?: Record<string, unknown>; version?: number; features?: Record<string, unknown> }
  | { type: "speech_end" }
  | { type: "cancel" }
  | { type: "listen"; state: string; mode?: string }
  | { type: "abort"; reason?: string };

function tryParseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws: WebSocket, message: string) {
  sendJson(ws, { type: "error", message });
}

function sendStatus(ws: WebSocket, stage: string) {
  sendJson(ws, { type: "status", stage });
}

export function createCheekStreamHandler(opts: {
  getConfig: () => CheekStreamConfig | undefined;
  log: CheekStreamLog;
}): {
  wss: WebSocketServer;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => void;
} {
  const { getConfig, log } = opts;
  const sessions = new Map<WebSocket, CheekStreamSession>();

  const wss = new WebSocketServer({ noServer: true });

  const HANDSHAKE_TIMEOUT_MS = 10_000;

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    log.info("cheeko: new WebSocket connection");

    // Require hello handshake within timeout
    const handshakeTimer = setTimeout(() => {
      if (!sessions.has(ws)) {
        sendError(ws, "handshake timeout — send hello message");
        ws.close(4001, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      const session = sessions.get(ws);

      if (isBinary) {
        // Binary frame: Opus audio chunk
        if (!session) {
          sendError(ws, "send hello before audio");
          return;
        }
        handleAudioChunk(session, data as Buffer);
        return;
      }

      // Text frame: JSON control message
      const text = typeof data === "string" ? data : data.toString("utf-8");
      const parsed = tryParseJson(text) as Record<string, unknown> | null;
      if (!parsed || typeof parsed.type !== "string") {
        sendError(ws, "invalid JSON control message");
        return;
      }

      const msg = parsed as unknown as ControlMessage;

      if (msg.type === "hello") {
        if (session) {
          sendError(ws, "already connected");
          return;
        }
        clearTimeout(handshakeTimer);
        handleHello(ws, msg, req);
        return;
      }

      if (!session) {
        sendError(ws, "send hello first");
        return;
      }

      switch (msg.type) {
        case "speech_end":
          handleSpeechEnd(session);
          break;
        case "cancel":
          handleCancel(session);
          break;
        case "listen":
          if (session.isEsp32Client) {
            if (msg.state === "start") {
              session.esp32ListeningMode = msg.mode || "manual";
            } else if (msg.state === "stop") {
              handleSpeechEnd(session);
            }
          } else {
            sendError(ws, `unknown message type: listen`);
          }
          break;
        case "abort":
          if (session.isEsp32Client) {
            handleCancel(session);
          } else {
            sendError(ws, `unknown message type: abort`);
          }
          break;
        default:
          sendError(ws, `unknown message type: ${(msg as Record<string, unknown>).type}`);
      }
    });

    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      const session = sessions.get(ws);
      if (session) {
        log.info(`cheeko: session ${session.sessionId} disconnected (device: ${session.deviceId})`);
        cleanupSession(session);
      }
    });

    ws.on("error", (err) => {
      log.warn(`cheeko: WebSocket error: ${String(err)}`);
    });
  });

  function handleHello(
    ws: WebSocket,
    msg: ControlMessage & { type: "hello" },
    req: IncomingMessage,
  ) {
    const config = getConfig();
    if (!config?.enabled) {
      sendError(ws, "cheeko stream endpoint is disabled");
      ws.close(4003, "disabled");
      return;
    }

    // Detect ESP32 clients by checking for fields that only ESP32 firmware sends
    const isEsp32 = msg.transport === "websocket" || msg.audio_params != null || typeof msg.version === "number";

    const deviceId = isEsp32
      ? (req.headers["device-id"] as string || `esp32-${randomUUID().slice(0, 8)}`)
      : (msg.deviceId || `device-${randomUUID().slice(0, 8)}`);
    const audioFormat: CheekAudioFormat = msg.clientType === "web" ? "pcm" : "opus";
    const protocolVersion = isEsp32
      ? ((msg.version ?? Number(req.headers["protocol-version"])) || 1)
      : 1;
    const sessionId = randomUUID();
    const session: CheekStreamSession = {
      sessionId,
      deviceId,
      ws,
      state: "idle",
      chatHistory: [],
      createdAt: Date.now(),
      audioFormat,
      sttStream: null,
      finalTranscript: "",
      chatHandle: null,
      ttsPipeline: null,
      speechEndAt: 0,
      firstAudioSent: false,
      isEsp32Client: isEsp32,
      protocolVersion,
      esp32ListeningMode: "manual",
    };
    sessions.set(ws, session);
    log.info(`cheeko: session ${sessionId} started for device ${deviceId} (audio: ${audioFormat}, esp32: ${isEsp32}, proto: ${protocolVersion})`);

    if (isEsp32) {
      // Respond in the format ESP32 firmware expects
      sendJson(ws, {
        type: "hello",
        transport: "websocket",
        session_id: sessionId,
        audio_params: {
          format: "opus",
          sample_rate: 24000,
          channels: 1,
          frame_duration: 20,
        },
      });
      // ESP32 does not expect status:idle after hello
    } else {
      sendJson(ws, {
        type: "hello_ack",
        sessionId,
        deviceId,
      });
      sendStatus(ws, "idle");
    }
  }

  function ensureSttStream(session: CheekStreamSession): CheekSttStream | null {
    // Return existing stream even if still connecting (avoid creating duplicates)
    if (session.sttStream) return session.sttStream;

    const config = getConfig();
    if (!config) {
      sendError(session.ws, "cheeko config unavailable");
      return null;
    }

    try {
      session.finalTranscript = "";
      session.sttStream = createSttStream({
        config,
        log,
        audioFormat: session.audioFormat,
        onTranscript(text, isFinal) {
          sendJson(session.ws, { type: "transcript", text, partial: !isFinal });
          if (isFinal) {
            session.finalTranscript += (session.finalTranscript ? " " : "") + text;
            log.info(`cheeko-stt: final segment: "${text}"`);
          }
        },
        onError(err) {
          sendError(session.ws, `STT error: ${String(err)}`);
        },
        onClose() {
          session.sttStream = null;
        },
      });
      return session.sttStream;
    } catch (err) {
      sendError(session.ws, `Failed to start STT: ${String(err)}`);
      return null;
    }
  }

  function handleAudioChunk(session: CheekStreamSession, data: Buffer) {
    if (session.state === "idle") {
      session.state = "listening";
      sendStatus(session.ws, "listening");
    }

    const stt = ensureSttStream(session);
    if (stt) {
      stt.sendAudio(data);
    }
  }

  function handleSpeechEnd(session: CheekStreamSession) {
    if (session.state !== "listening") {
      sendError(session.ws, "not currently listening");
      return;
    }
    session.state = "processing";
    session.speechEndAt = Date.now();
    session.firstAudioSent = false;
    sendStatus(session.ws, "stt");
    log.info(`cheeko: session ${session.sessionId} speech ended, finalizing STT`);

    // Flush Deepgram's buffer to get any remaining transcript
    if (session.sttStream?.isConnected()) {
      session.sttStream.finalize();
    }

    // Wait for Deepgram to send back final transcript before proceeding.
    // The STT stream will deliver remaining transcripts via onTranscript callback.
    // Give Deepgram up to 2s to flush, then proceed with whatever we have.
    const waitForTranscript = () => {
      closeSttStream(session);

      const transcript = session.finalTranscript.trim();
      if (transcript) {
        log.info(`cheeko: session ${session.sessionId} transcript: "${transcript}"`);
      }

      if (!transcript) {
        log.info(`cheeko: session ${session.sessionId} empty transcript, returning to idle`);
        session.state = "idle";
        sendStatus(session.ws, "idle");
        return;
      }

      proceedWithTranscript(session, transcript);
    };

    // Delay to allow final transcript to arrive from Deepgram
    setTimeout(waitForTranscript, 800);
  }

  function proceedWithTranscript(session: CheekStreamSession, transcript: string) {

    // Add user message to conversation history
    session.chatHistory.push({ role: "user", content: transcript });

    // Route through LLM — use a per-device session key for voice conversations
    sendStatus(session.ws, "thinking");
    const sessionKey = `voice:${session.deviceId}`;

    // Create TTS pipeline to stream audio back to client
    const config = getConfig();
    if (config) {
      const onAudioFrame = (frame: Buffer) => {
        if (session.ws.readyState === WebSocket.OPEN) {
          if (!session.firstAudioSent && session.speechEndAt > 0) {
            const latencyMs = Date.now() - session.speechEndAt;
            log.info(`cheeko: session ${session.sessionId} latency speech_end→first_audio: ${latencyMs}ms`);
            sendJson(session.ws, { type: "latency", speechEndToFirstAudio: latencyMs });
            session.firstAudioSent = true;
          }
          session.ws.send(frame);
        }
      };
      session.ttsPipeline = createTtsPipeline({
        config,
        log,
        outputFormat: session.audioFormat,
        onAudioFrame,
        onComplete() {
          session.ttsPipeline = null;
          sendJson(session.ws, { type: "audio_end" });
          session.state = "idle";
          sendStatus(session.ws, "idle");
          log.info(`cheeko: session ${session.sessionId} TTS complete`);
        },
        onError(err) {
          session.ttsPipeline = null;
          sendError(session.ws, `TTS error: ${err}`);
          session.state = "idle";
          sendStatus(session.ws, "idle");
          log.warn(`cheeko: session ${session.sessionId} TTS error: ${err}`);
        },
      });
    }

    session.chatHandle = sendChatMessage({
      transcript,
      sessionKey,
      log,
      callbacks: {
        onTextChunk(text) {
          // Send text chunk to client for display
          sendJson(session.ws, { type: "response_text", text, partial: true });
          // Feed sentence into TTS pipeline for audio streaming
          if (session.ttsPipeline) {
            session.ttsPipeline.pushSentence(text);
          }
        },
        onComplete(fullText) {
          session.chatHandle = null;
          if (fullText) {
            session.chatHistory.push({ role: "assistant", content: fullText });
          }
          // Send final text to client
          sendJson(session.ws, { type: "response_text", text: fullText, partial: false });
          // Transition to speaking while TTS finishes streaming audio
          session.state = "speaking";
          sendStatus(session.ws, "speaking");
          log.info(`cheeko: session ${session.sessionId} LLM response complete (${fullText.length} chars), streaming TTS`);
          // Signal TTS that no more sentences will arrive
          if (session.ttsPipeline) {
            session.ttsPipeline.finish();
          } else {
            // No TTS pipeline — return to idle
            sendJson(session.ws, { type: "audio_end" });
            session.state = "idle";
            sendStatus(session.ws, "idle");
          }
        },
        onError(err) {
          session.chatHandle = null;
          abortTts(session);
          sendError(session.ws, `LLM error: ${err}`);
          session.state = "idle";
          sendStatus(session.ws, "idle");
          log.warn(`cheeko: session ${session.sessionId} LLM error: ${err}`);
        },
      },
    });
  }

  function closeSttStream(session: CheekStreamSession) {
    if (session.sttStream) {
      session.sttStream.close();
      session.sttStream = null;
    }
  }

  function handleCancel(session: CheekStreamSession) {
    log.info(`cheeko: session ${session.sessionId} cancel requested`);
    closeSttStream(session);
    abortChat(session);
    abortTts(session);
    session.state = "idle";
    sendStatus(session.ws, "idle");
  }

  function abortChat(session: CheekStreamSession) {
    if (session.chatHandle) {
      session.chatHandle.abort();
      session.chatHandle = null;
    }
  }

  function abortTts(session: CheekStreamSession) {
    if (session.ttsPipeline) {
      session.ttsPipeline.abort();
      session.ttsPipeline = null;
    }
  }

  function cleanupSession(session: CheekStreamSession) {
    closeSttStream(session);
    abortChat(session);
    abortTts(session);
    sessions.delete(session.ws);
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== CHEEKO_STREAM_PATH) {
      return false;
    }

    const config = getConfig();
    log.info(`cheeko: handleUpgrade config=${JSON.stringify(config ?? null)}`);
    if (!config?.enabled) {
      log.warn(`cheeko: rejecting upgrade — enabled=${config?.enabled}, config exists=${config != null}`);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    log.info("cheeko: upgrade accepted, proceeding with WebSocket handshake");

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return true;
  }

  function close() {
    for (const [ws, session] of sessions) {
      cleanupSession(session);
      ws.close(1001, "server shutting down");
    }
    wss.close();
  }

  return { wss, handleUpgrade, close };
}
