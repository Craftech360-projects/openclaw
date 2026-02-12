import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { CheekStreamConfig } from "../config/types.gateway.js";

export const CHEEKO_STREAM_PATH = "/cheeko/stream";

/** Per-connection session state. */
export type CheekStreamSession = {
  sessionId: string;
  deviceId: string;
  ws: WebSocket;
  state: "idle" | "listening" | "processing" | "speaking";
  chatHistory: Array<{ role: string; content: string }>;
  createdAt: number;
};

export type CheekStreamLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
};

type ControlMessage =
  | { type: "hello"; deviceId?: string; token?: string }
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

  function handleHello(ws: WebSocket, msg: { type: "hello"; deviceId?: string; token?: string }) {
    const config = getConfig();
    if (!config?.enabled) {
      sendError(ws, "cheeko stream endpoint is disabled");
      ws.close(4003, "disabled");
      return;
    }

    const deviceId = msg.deviceId || `device-${randomUUID().slice(0, 8)}`;
    const sessionId = randomUUID();
    const session: CheekStreamSession = {
      sessionId,
      deviceId,
      ws,
      state: "idle",
      chatHistory: [],
      createdAt: Date.now(),
    };
    sessions.set(ws, session);
    log.info(`cheeko: session ${sessionId} started for device ${deviceId}`);
    sendJson(ws, {
      type: "hello_ack",
      sessionId,
      deviceId,
    });
    sendStatus(ws, "idle");
  }

  function handleAudioChunk(session: CheekStreamSession, _data: Buffer) {
    // Audio chunk received — STT processing will be implemented in Task 4
    if (session.state === "idle") {
      session.state = "listening";
      sendStatus(session.ws, "listening");
    }
  }

  function handleSpeechEnd(session: CheekStreamSession) {
    if (session.state !== "listening") {
      sendError(session.ws, "not currently listening");
      return;
    }
    session.state = "processing";
    sendStatus(session.ws, "stt");
    log.info(`cheeko: session ${session.sessionId} speech ended, processing`);
    // STT finalization and LLM routing will be implemented in Tasks 4-5
    // For now, acknowledge and return to idle
    session.state = "idle";
    sendStatus(session.ws, "idle");
  }

  function handleCancel(session: CheekStreamSession) {
    log.info(`cheeko: session ${session.sessionId} cancel requested`);
    // Cancel any active STT/TTS streams (will be implemented in Tasks 4-6)
    session.state = "idle";
    sendStatus(session.ws, "idle");
  }

  function cleanupSession(session: CheekStreamSession) {
    // Clean up STT/TTS resources (will be implemented in Tasks 4-6)
    sessions.delete(session.ws);
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== CHEEKO_STREAM_PATH) {
      return false;
    }

    const config = getConfig();
    if (!config?.enabled) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }

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
