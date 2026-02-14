import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";
import { emitMusicPlay, emitMusicStop } from "../../gateway/cheeko-music-events.js";

const MusicToolSchema = Type.Object({
  action: Type.Union([Type.Literal("play"), Type.Literal("stop")], {
    description: 'Action to perform: "play" to start playing music, "stop" to stop current music.',
  }),
  query: Type.Optional(
    Type.String({ description: 'Search query for YouTube music (required for "play" action). E.g. "Baby Shark".' }),
  ),
});

export function createMusicTool(opts?: {
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Music",
    name: "music",
    description:
      "Play or stop music from YouTube via the voice stream. Use when the child asks to play a song, hear music, or stop the current song. The music will stream through the voice connection after your spoken response finishes.",
    parameters: MusicToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const sessionKey = opts?.agentSessionKey;

      if (!sessionKey) {
        return {
          content: [{ type: "text", text: "Music is only available during voice conversations." }],
          details: { error: "no session key" },
        };
      }

      switch (action) {
        case "play": {
          const query = readStringParam(params, "query", { required: true });
          emitMusicPlay(sessionKey, query);
          return {
            content: [{ type: "text", text: `Playing "${query}" from YouTube. The music will start after your spoken response.` }],
            details: { action: "play", query },
          };
        }

        case "stop": {
          emitMusicStop(sessionKey);
          return {
            content: [{ type: "text", text: "Music stopped." }],
            details: { action: "stop" },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}. Use "play" or "stop".` }],
            details: { error: `unknown action: ${action}` },
          };
      }
    },
  };
}
