import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { onAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { loadSessionEntry } from "./session-utils.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { CheekStreamLog } from "./cheeko-stream.js";

/** Sentence boundary regex — split on . ! ? followed by whitespace or end. */
const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+/;

/**
 * Accumulates streamed text and flushes complete sentences to a callback.
 * Remaining partial sentence is flushed on finalize.
 */
function createSentenceBuffer(onSentence: (text: string) => void) {
  let buffer = "";

  return {
    push(text: string) {
      buffer += text;
      // Flush complete sentences
      const parts = buffer.split(SENTENCE_BOUNDARY_RE);
      if (parts.length > 1) {
        // All but last part are complete sentences
        for (let i = 0; i < parts.length - 1; i++) {
          const sentence = parts[i].trim();
          if (sentence) {
            onSentence(sentence);
          }
        }
        buffer = parts[parts.length - 1];
      }
    },
    flush() {
      const remaining = buffer.trim();
      buffer = "";
      if (remaining) {
        onSentence(remaining);
      }
    },
  };
}

export type CheekChatCallbacks = {
  /** Called with sentence-sized text chunks as the LLM streams its response. */
  onTextChunk: (text: string) => void;
  /** Called when the full LLM response is complete. */
  onComplete: (fullText: string) => void;
  /** Called on error. */
  onError: (err: string) => void;
};

export type CheekChatHandle = {
  /** Abort the in-flight LLM run. */
  abort: () => void;
};

/**
 * Sends user transcript through the existing OpenClaw chat pipeline and
 * streams LLM text back as sentence-sized chunks for TTS consumption.
 *
 * Uses `default#voice` as the session key so voice conversations get their
 * own session and transcript history, separate from webchat.
 */
export function sendChatMessage(opts: {
  transcript: string;
  sessionKey: string;
  log: CheekStreamLog;
  callbacks: CheekChatCallbacks;
}): CheekChatHandle {
  const { transcript, sessionKey, log, callbacks } = opts;
  const runId = `cheeko-${randomUUID()}`;
  const abortController = new AbortController();

  let fullText = "";
  const sentenceBuffer = createSentenceBuffer((sentence) => {
    callbacks.onTextChunk(sentence);
  });

  // Subscribe to agent events for streaming text deltas
  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) return;

    if (evt.stream === "assistant") {
      // data.text = accumulated full text; data.delta = incremental chunk
      if (typeof evt.data?.text === "string") {
        fullText = evt.data.text;
      }
      const delta = typeof evt.data?.delta === "string" ? evt.data.delta : "";
      if (delta) {
        sentenceBuffer.push(delta);
      }
    }

    if (evt.stream === "lifecycle") {
      if (evt.data?.phase === "end") {
        sentenceBuffer.flush();
        unsubscribe();
        callbacks.onComplete(fullText);
      } else if (evt.data?.phase === "error") {
        sentenceBuffer.flush();
        unsubscribe();
        callbacks.onError(String(evt.data?.error ?? "LLM run failed"));
      }
    }
  });

  // Resolve config and session
  let cfg: OpenClawConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    unsubscribe();
    callbacks.onError(`Failed to load config: ${String(err)}`);
    return { abort: () => {} };
  }

  const { canonicalKey } = loadSessionEntry(sessionKey);
  const agentId = resolveSessionAgentId({ sessionKey: canonicalKey, config: cfg });

  // Register agent run context so events are enriched with sessionKey
  registerAgentRunContext(runId, {
    sessionKey: canonicalKey,
    verboseLevel: "off",
  });

  // Build MsgContext matching the pattern from chat.send handler.
  // Instruct the agent to reply with plain text only — audio synthesis is handled
  // externally by the cheeko voice pipeline (STT → LLM → TTS).
  const voicePrefix =
    "[Voice conversation — respond with plain text only. Do NOT use the tts tool. Audio is handled by the voice pipeline. IMPORTANT: Always include a spoken text response even when calling tools (e.g. say \"Sure, playing Baby Shark!\" before calling the music tool). Never respond with only a tool call and no text.]\n";

  const ctx: MsgContext = {
    Body: transcript,
    BodyForAgent: voicePrefix + transcript,
    BodyForCommands: transcript,
    RawBody: transcript,
    CommandBody: transcript,
    SessionKey: canonicalKey,
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
    ChatType: "direct",
    CommandAuthorized: true,
    MessageSid: runId,
    SenderId: "cheeko-voice",
    SenderName: "Voice User",
  };

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: INTERNAL_MESSAGE_CHANNEL,
  });

  const dispatcher = createReplyDispatcher({
    ...prefixOptions,
    onError: (err) => {
      log.warn(`cheeko-chat: dispatch error: ${String(err)}`);
    },
    deliver: async (_payload, _info) => {
      // We capture text via agent events, not the dispatcher delivery.
      // The dispatcher is still needed for the pipeline to run.
    },
  });

  // Fire and forget — the agent event listener handles streaming
  void dispatchInboundMessage({
    ctx,
    cfg,
    dispatcher,
    replyOptions: {
      runId,
      abortSignal: abortController.signal,
      disableBlockStreaming: true,
      onModelSelected,
    },
  }).catch((err) => {
    unsubscribe();
    callbacks.onError(`Chat dispatch failed: ${String(err)}`);
  });

  log.info(`cheeko-chat: dispatched message to agent (runId: ${runId}, session: ${canonicalKey})`);

  return {
    abort() {
      abortController.abort();
      unsubscribe();
    },
  };
}
