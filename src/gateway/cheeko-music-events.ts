import { EventEmitter } from "node:events";

/**
 * Singleton EventEmitter bridge for music commands between agent tools and cheeko-stream.
 *
 * Agent tool calls `emitMusicPlay(sessionKey, query)` →
 * cheeko-stream listens and spawns yt-dlp + ffmpeg to stream audio.
 */

const musicBus = new EventEmitter();
musicBus.setMaxListeners(50);

export type MusicPlayEvent = {
  sessionKey: string;
  query: string;
};

export type MusicStopEvent = {
  sessionKey: string;
};

export function emitMusicPlay(sessionKey: string, query: string): void {
  musicBus.emit("music:play", { sessionKey, query } satisfies MusicPlayEvent);
}

export function emitMusicStop(sessionKey: string): void {
  musicBus.emit("music:stop", { sessionKey } satisfies MusicStopEvent);
}

export function onMusicPlay(handler: (event: MusicPlayEvent) => void): void {
  musicBus.on("music:play", handler);
}

export function onMusicStop(handler: (event: MusicStopEvent) => void): void {
  musicBus.on("music:stop", handler);
}

export function offMusicPlay(handler: (event: MusicPlayEvent) => void): void {
  musicBus.off("music:play", handler);
}

export function offMusicStop(handler: (event: MusicStopEvent) => void): void {
  musicBus.off("music:stop", handler);
}
