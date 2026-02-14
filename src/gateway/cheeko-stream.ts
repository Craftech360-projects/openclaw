import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { CheekStreamConfig } from "../config/types.gateway.js";
import { createSttStream, type CheekSttStream } from "./cheeko-stt.js";
import { sendChatMessage, type CheekChatHandle } from "./cheeko-chat.js";
import { createTtsPipeline } from "./cheeko-tts.js";
import { streamMusic, type MusicHandle } from "./cheeko-music.js";
import {
  onMusicPlay,
  onMusicStop,
  offMusicPlay,
  offMusicStop,
  type MusicPlayEvent,
  type MusicStopEvent,
} from "./cheeko-music-events.js";

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
  /** Active music streaming handle (for abort support). */
  musicHandle: MusicHandle | null;
  /** Pending music query — will start after TTS completes. */
  pendingMusicQuery: string | null;
};

export type CheekStreamLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
};

type ControlMessage =
  | { type: "hello"; deviceId?: string; token?: string; clientType?: string }
  | { type: "speech_end" }
  | { type: "cancel" };

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

  // --- Music event bridge listeners ---

  function findSessionByKey(sessionKey: string): CheekStreamSession | undefined {
    for (const session of sessions.values()) {
      // Match both raw key (voice:deviceId) and canonical key (agent:main:voice:deviceId)
      const voiceKey = `voice:${session.deviceId}`;
      if (sessionKey === voiceKey || sessionKey.endsWith(`:${voiceKey}`)) {
        return session;
      }
    }
    return undefined;
  }

  function handleMusicPlayEvent(event: MusicPlayEvent) {
    const session = findSessionByKey(event.sessionKey);
    if (!session) return;
    // Queue the music request — it will start after TTS completes
    session.pendingMusicQuery = event.query;
    log.info(`cheeko: session ${session.sessionId} music queued: "${event.query}"`);
  }

  function handleMusicStopEvent(event: MusicStopEvent) {
    const session = findSessionByKey(event.sessionKey);
    if (!session) return;
    session.pendingMusicQuery = null;
    if (session.musicHandle) {
      abortMusic(session);
      sendJson(session.ws, { type: "music_end" });
      session.state = "idle";
      sendStatus(session.ws, "idle");
      log.info(`cheeko: session ${session.sessionId} music stopped by agent`);
    }
  }

  onMusicPlay(handleMusicPlayEvent);
  onMusicStop(handleMusicStopEvent);

  function startMusicForSession(session: CheekStreamSession, query: string) {
    abortMusic(session); // Stop any existing music first
    session.pendingMusicQuery = null;

    sendJson(session.ws, { type: "music_start", query });
    log.info(`cheeko: session ${session.sessionId} starting music: "${query}"`);

    session.musicHandle = streamMusic({
      query,
      outputFormat: session.audioFormat,
      log,
      onAudioFrame(frame) {
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(frame);
        }
      },
      onComplete() {
        session.musicHandle = null;
        sendJson(session.ws, { type: "music_end" });
        session.state = "idle";
        sendStatus(session.ws, "idle");
        log.info(`cheeko: session ${session.sessionId} music complete`);
      },
      onError(msg) {
        session.musicHandle = null;
        sendJson(session.ws, { type: "music_end" });
        session.state = "idle";
        sendStatus(session.ws, "idle");
        log.warn(`cheeko: session ${session.sessionId} music error: ${msg}`);
      },
    });
  }

  const HANDSHAKE_TIMEOUT_MS = 10_000;

  wss.on("connection", (ws: WebSocket) => {
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
        handleHello(ws, msg);
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

  function handleHello(ws: WebSocket, msg: { type: "hello"; deviceId?: string; token?: string; clientType?: string }) {
    const config = getConfig();
    if (!config?.enabled) {
      sendError(ws, "cheeko stream endpoint is disabled");
      ws.close(4003, "disabled");
      return;
    }

    const deviceId = msg.deviceId || `device-${randomUUID().slice(0, 8)}`;
    const audioFormat: CheekAudioFormat = msg.clientType === "web" ? "pcm" : "opus";
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
      musicHandle: null,
      pendingMusicQuery: null,
    };
    sessions.set(ws, session);
    log.info(`cheeko: session ${sessionId} started for device ${deviceId} (audio: ${audioFormat})`);
    sendJson(ws, {
      type: "hello_ack",
      sessionId,
      deviceId,
    });
    sendStatus(ws, "idle");
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
    // If music is playing, stop it when the user starts talking
    const wasPlayingMusic = session.musicHandle !== null;
    if (wasPlayingMusic) {
      abortMusic(session);
      sendJson(session.ws, { type: "music_end" });
    }

    if (session.state === "idle" || wasPlayingMusic) {
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
          log.info(`cheeko: session ${session.sessionId} TTS complete`);

          // If music was queued by the LLM, start it now
          if (session.pendingMusicQuery) {
            const query = session.pendingMusicQuery;
            startMusicForSession(session, query);
          } else {
            session.state = "idle";
            sendStatus(session.ws, "idle");
          }
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
    abortMusic(session);
    session.pendingMusicQuery = null;
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

  function abortMusic(session: CheekStreamSession) {
    if (session.musicHandle) {
      session.musicHandle.abort();
      session.musicHandle = null;
    }
  }

  function cleanupSession(session: CheekStreamSession) {
    closeSttStream(session);
    abortChat(session);
    abortTts(session);
    abortMusic(session);
    session.pendingMusicQuery = null;
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
    offMusicPlay(handleMusicPlayEvent);
    offMusicStop(handleMusicStopEvent);
    for (const [ws, session] of sessions) {
      cleanupSession(session);
      ws.close(1001, "server shutting down");
    }
    wss.close();
  }

  return { wss, handleUpgrade, close };
}
