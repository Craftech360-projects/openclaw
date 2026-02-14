# OpenClaw — Tools & Skills Reference

## Built-in Agent Tools

These are core tools available to every OpenClaw agent session. They are defined in `src/agents/tools/`.

| Tool | Description | File |
|------|-------------|------|
| `web_search` | Search the web via configured provider (Google, Brave, Tavily, etc.) | `src/agents/tools/web-search.ts` |
| `web_fetch` | Fetch and extract content from a URL (supports Firecrawl, Readability) | `src/agents/tools/web-fetch.ts` |
| `browser` | Headless browser automation — navigate, click, type, screenshot | `src/agents/tools/browser-tool.ts` |
| `image` | Generate or edit images via configured provider (DALL-E, Gemini, etc.) | `src/agents/tools/image-tool.ts` |
| `canvas` | Display HTML content on connected OpenClaw nodes (Mac, iOS, Android) | `src/agents/tools/canvas-tool.ts` |
| `message` | Send a message to a specific session/channel (WhatsApp, Telegram, Slack, etc.) | `src/agents/tools/message-tool.ts` |
| `tts` | Text-to-speech — synthesize speech and play on local device | `src/agents/tools/tts-tool.ts` |
| `cron` | Schedule recurring or one-time jobs (reminders, alarms, timers) | `src/agents/tools/cron-tool.ts` |
| `memory_search` | Search long-term memory (vector-based recall) | `src/agents/tools/memory-tool.ts` |
| `memory_get` | Retrieve a specific memory entry by ID | `src/agents/tools/memory-tool.ts` |
| `gateway` | Control the OpenClaw gateway (restart, status, config) | `src/agents/tools/gateway-tool.ts` |
| `session_status` | Get status of a session (last message, model, active state) | `src/agents/tools/session-status-tool.ts` |
| `sessions_list` | List all active sessions with metadata | `src/agents/tools/sessions-list-tool.ts` |
| `sessions_history` | Retrieve conversation history for a session | `src/agents/tools/sessions-history-tool.ts` |
| `sessions_send` | Send a message into another session (cross-session messaging) | `src/agents/tools/sessions-send-tool.ts` |
| `sessions_spawn` | Spawn a new sub-agent session for a task | `src/agents/tools/sessions-spawn-tool.ts` |
| `agents_list` | List all configured agents | `src/agents/tools/agents-list-tool.ts` |
| `nodes` | Manage connected OpenClaw nodes (list, status, push content) | `src/agents/tools/nodes-tool.ts` |

## Plugin-Provided Tools

Plugins registered in `openclaw.json → plugins.entries` can inject additional tools.

| Plugin | Tools Provided | Config |
|--------|---------------|--------|
| `memory-core` | Memory capture, recall, and lifecycle hooks | `plugins.entries.memory-core.enabled: true` |
| `memory-lancedb` | Vector storage backend (LanceDB) for memory search | `plugins.entries.memory-lancedb.enabled: true` |
| `whatsapp` | WhatsApp login tool, message actions | `plugins.entries.whatsapp.enabled: true` |
| `telegram` | Telegram message actions (react, pin, reply) | `plugins.entries.telegram.enabled: true` |
| `google-antigravity-auth` | Google OAuth authentication | `plugins.entries.google-antigravity-auth.enabled: true` |
| `voice-call` | Initiate voice calls (Twilio, Telnyx, Plivo) | `plugins.entries.voice-call` config |

## Channel Action Tools

These are injected automatically when the corresponding channel is enabled.

| Channel | Actions Available | Config Key |
|---------|------------------|------------|
| Discord | Send messages, reactions, polls, threads, moderation, guild actions, presence | `channels.discord` |
| Slack | Send messages, reactions, pins, thread replies | `channels.slack` |
| Telegram | Send messages, reactions, pins, edit/delete messages | `channels.telegram` |
| WhatsApp | Send messages, polls, media, login QR | `channels.whatsapp` / `plugins.entries.whatsapp` |
| Signal | Send messages, reactions | `channels.signal` |
| iMessage | Send iMessages/SMS | `channels.imessage` |
| LINE | Push messages, flex messages, template messages, quick replies | `channels.line` |

---

## Skills (CLI-based Agent Tools)

Skills are opt-in tools the agent can use by invoking CLI binaries. Located in `skills/`. Enable in `openclaw.json → skills.entries`.

### Communication & Messaging

| Skill | Description | CLI Binary | Required Config |
|-------|-------------|-----------|-----------------|
| `bluebubbles` | Send/manage iMessages via BlueBubbles server | — | `channels.bluebubbles` |
| `discord` | Control Discord (messages, reactions, threads, polls, moderation) | — | `channels.discord` |
| `himalaya` | Email via IMAP/SMTP (list, read, write, reply, forward, search) | `himalaya` | IMAP/SMTP credentials |
| `imsg` | iMessage/SMS CLI (list chats, history, watch, send) on macOS | `imsg` | Messages.app |
| `slack` | Control Slack (react, pin, message) | — | `channels.slack` |
| `voice-call` | Start voice calls via Twilio/Telnyx/Plivo | — | `plugins.entries.voice-call` |
| `wacli` | Send WhatsApp messages, search/sync history | `wacli` | — |

### Productivity & Notes

| Skill | Description | CLI Binary | Required Config |
|-------|-------------|-----------|-----------------|
| `1password` | 1Password CLI for secret management | `op` | — |
| `apple-notes` | Manage Apple Notes on macOS | `memo` | — |
| `apple-reminders` | Manage Apple Reminders on macOS | `remindctl` | — |
| `bear-notes` | Create, search, manage Bear notes | `grizzly` | Bear app + auth token |
| `notion` | Notion API (pages, databases, blocks) | — | `NOTION_API_KEY` |
| `obsidian` | Work with Obsidian vaults | `obsidian-cli` | — |
| `things-mac` | Manage Things 3 (projects + todos) on macOS | `things` | `THINGS_AUTH_TOKEN` (optional) |
| `trello` | Manage Trello boards, lists, cards | `jq` | `TRELLO_API_KEY`, `TRELLO_TOKEN` |

### Media & Audio

| Skill | Description | CLI Binary | Required Config |
|-------|-------------|-----------|-----------------|
| `sag` | ElevenLabs text-to-speech (local playback) | `sag` | `ELEVENLABS_API_KEY` |
| `sherpa-onnx-tts` | Local offline text-to-speech via sherpa-onnx | — | `SHERPA_ONNX_RUNTIME_DIR`, `SHERPA_ONNX_MODEL_DIR` |
| `spotify-player` | Spotify playback/search (local speakers) | `spogo` / `spotify_player` | Spotify Premium |
| `songsee` | Generate spectrograms and audio visualizations | `songsee` | — |
| `sonoscli` | Control Sonos speakers (play, volume, group) | `sonos` | — |
| `blucli` | BluOS CLI (discovery, playback, grouping, volume) | `blu` | — |
| `video-frames` | Extract frames/clips from video files | `ffmpeg` | — |
| `camsnap` | Capture frames/clips from RTSP/ONVIF cameras | `camsnap` | — |

### AI & Code

| Skill | Description | CLI Binary | Required Config |
|-------|-------------|-----------|-----------------|
| `coding-agent` | Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent | `claude` / `codex` / `opencode` / `pi` | — |
| `gemini` | Gemini CLI for one-shot Q&A, summaries, generation | `gemini` | — |
| `oracle` | Prompt + file bundling, multi-engine sessions | `oracle` | `OPENAI_API_KEY` (optional) |
| `openai-image-gen` | Batch-generate images via OpenAI Images API | `python3` | `OPENAI_API_KEY` |
| `nano-banana-pro` | Generate/edit images via Gemini 3 Pro Image | `uv` | `GEMINI_API_KEY` |
| `summarize` | Summarize/extract text from URLs, podcasts, files | `summarize` | API key (OpenAI/Anthropic/Gemini/xAI) |
| `skill-creator` | Create or update AgentSkills with scripts and assets | — | — |

### Web & Search

| Skill | Description | CLI Binary | Required Config |
|-------|-------------|-----------|-----------------|
| `github` | GitHub CLI (issues, PRs, CI, API queries) | `gh` | — |
| `blogwatcher` | Monitor blogs and RSS/Atom feeds | `blogwatcher` | — |
| `gifgrep` | Search GIF providers, download, extract stills | `gifgrep` | `GIPHY_API_KEY` / `TENOR_API_KEY` (optional) |
| `goplaces` | Google Places API text search and details | `goplaces` | `GOOGLE_PLACES_API_KEY` |
| `local-places` | Local Google Places API proxy | `uv` | `GOOGLE_PLACES_API_KEY` |
| `weather` | Current weather and forecasts | `curl` | — |

### Speech & Transcription

| Skill | Description | CLI Binary | Required Config |
|-------|-------------|-----------|-----------------|
| `openai-whisper` | Local speech-to-text (Whisper CLI, no API) | `whisper` | — |
| `openai-whisper-api` | Transcribe audio via OpenAI Whisper API | `curl` | `OPENAI_API_KEY` |

### System & Utilities

| Skill | Description | CLI Binary | Required Config |
|-------|-------------|-----------|-----------------|
| `canvas` | Display HTML on connected OpenClaw nodes | — | — |
| `clawhub` | Search, install, publish skills from clawhub.com | `clawhub` | — |
| `eightctl` | Control Eight Sleep pods (temp, alarms, schedules) | `eightctl` | `EIGHTCTL_EMAIL`, `EIGHTCTL_PASSWORD` |
| `food-order` | Reorder Foodora orders, track ETA/status | `ordercli` | — |
| `gog` | Google Workspace (Gmail, Calendar, Drive, Sheets, Docs) | `gog` | OAuth credentials |
| `healthcheck` | Host security hardening and risk-tolerance config | — | — |
| `mcporter` | Work with MCP servers (list, call tools, auth, daemon) | `mcporter` | — |
| `model-usage` | Per-model usage cost from CodexBar logs | `codexbar` | — |
| `nano-pdf` | Edit PDFs with natural-language instructions | `nano-pdf` | — |
| `openhue` | Control Philips Hue lights/scenes | `openhue` | — |
| `ordercli` | Foodora CLI (past orders, active order status) | `ordercli` | — |
| `peekaboo` | Capture and automate macOS UI | `peekaboo` | — |
| `session-logs` | Search and analyze session logs | `jq`, `rg` | — |
| `tmux` | Remote-control tmux sessions (send keystrokes) | `tmux` | — |

---

## Currently Enabled (this deployment)

Based on `~/.openclaw/openclaw.json`:

**Plugins enabled:**
- `whatsapp`
- `google-antigravity-auth`
- `telegram`
- `memory-core`
- `memory-lancedb`

**Skills enabled:**
- `notion` (API key configured)
- `spotify-player`

**Voice Pipeline (Cheeko):**
- STT: Deepgram Nova-2
- LLM: Google Gemini 2.0 Flash
- TTS: ElevenLabs (eleven_turbo_v2, voice: UbB19hYD8fvYxwJAVTY5)

**Channels enabled:**
- Telegram (bot token configured)
