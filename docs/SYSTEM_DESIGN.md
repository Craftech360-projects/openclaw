# OpenClaw - System Design Document

> **Version:** 1.0
> **Date:** 2026-02-13
> **Audience:** Internal reference & new contributors
> **Status:** Living document

---

## Table of Contents

1. [Overview](#1-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Core Components](#3-core-components)
4. [Voice Pipeline (Cheeko)](#4-voice-pipeline-cheeko)
5. [Multi-Channel Messaging](#5-multi-channel-messaging)
6. [Agent & LLM Orchestration](#6-agent--llm-orchestration)
7. [Plugin & Extension System](#7-plugin--extension-system)
8. [Configuration System](#8-configuration-system)
9. [Session & State Management](#9-session--state-management)
10. [Security Architecture](#10-security-architecture)
11. [Data Models & Key Types](#11-data-models--key-types)
12. [API Reference](#12-api-reference)
13. [Frontend & Native Apps](#13-frontend--native-apps)
14. [Deployment Architecture](#14-deployment-architecture)
15. [Development Workflow](#15-development-workflow)
16. [Observability & Diagnostics](#16-observability--diagnostics)
17. [Roadmap & Future Directions](#17-roadmap--future-directions)

---

## 1. Overview

### What is OpenClaw?

OpenClaw is a **personal AI assistant platform** that you run on your own devices. It acts as a unified gateway between you and multiple AI models (Claude, GPT, Gemini) across 40+ messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Matrix, and more), with real-time voice conversation support.

### Design Philosophy

- **Local-first:** All data, sessions, and credentials stay on your machine by default
- **Multi-channel:** One assistant, reachable everywhere — same context across all channels
- **Extensible:** Plugin SDK for custom channels, tools, and integrations
- **Model-agnostic:** Swap LLM providers without changing your workflow
- **Voice-native:** First-class voice conversation with streaming STT/TTS

### Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| **Gateway (control plane)** | Node.js 22+, TypeScript (ESM), Express, WebSocket |
| **Voice Pipeline (Cheeko)** | Custom WebSocket streaming, Deepgram STT, OpusScript codec |
| **TTS Providers** | OpenAI TTS API, ElevenLabs, Edge TTS (node-edge-tts) |
| **LLM Providers** | Anthropic Claude, OpenAI GPT, Google Gemini, Ollama |
| **Telephony** | Voice-call extension (Twilio, Telnyx, Plivo) |
| **Frontend** | React + Vite (web UI), vanilla JS (voice client) |
| **Native Apps** | Swift/SwiftUI (macOS/iOS), Kotlin (Android) |
| **Package Management** | pnpm 10.23+ |
| **Testing** | Vitest (V8 coverage, 70% threshold) |
| **Deployment** | Docker, Fly.io, Render, systemd/launchd |

---

## 2. High-Level Architecture

### System Context

```mermaid
graph TB
    subgraph Users
        U1[User via WhatsApp]
        U2[User via Telegram]
        U3[User via Discord]
        U4["User via Voice/Browser"]
        U5[User via CLI]
        U6["User via macOS/iOS/Android"]
    end

    subgraph OpenClaw["OpenClaw Platform"]
        GW[Gateway Control Plane<br/>Node.js :18789]
        CHEEKO["Cheeko Voice Pipeline<br/>WS /cheeko/stream"]
        UI[Web UI<br/>React + Vite]
        CLI[CLI Interface<br/>Commander.js]
    end

    subgraph External["External Services"]
        DG[Deepgram STT<br/>Nova-2 streaming]
        TTS["TTS Providers<br/>OpenAI / ElevenLabs / Edge"]
        LLM["LLM Providers<br/>Claude / GPT / Gemini"]
    end

    U1 & U2 & U3 --> GW
    U4 -->|WebSocket + Opus| CHEEKO
    U4 --> UI
    U5 --> CLI --> GW
    U6 --> GW

    GW --> LLM
    CHEEKO --> DG
    CHEEKO --> TTS
    CHEEKO --> GW
```

### Component Interaction

```mermaid
flowchart LR
    subgraph Inbound
        CH[Channel Adapters<br/>40+ channels]
        WS["WebSocket<br/>/cheeko/stream"]
        HTTP["HTTP API<br/>/v1/chat/completions"]
    end

    subgraph Core["Core Engine"]
        DR[Dispatch Router]
        AR[Auto-Reply Engine]
        AG[Agent Runtime<br/>Pi Framework]
        SM[Session Manager]
        PR[Plugin Registry]
    end

    subgraph Outbound
        RM[Reply Dispatcher]
        TS[TTS Synthesis]
        CA[Channel Adapters]
    end

    CH --> DR --> AR --> AG
    WS --> DR
    HTTP --> DR
    AG --> SM
    AG --> PR
    AG --> RM --> CA
    AG --> TS
```

---

## 3. Core Components

### 3.1 Gateway Control Plane

The gateway is the heart of OpenClaw — a WebSocket-based control plane that orchestrates all messaging, agent execution, and real-time communication.

```mermaid
graph TD
    subgraph Gateway["Gateway (port 18789)"]
        WSS[WebSocket Server]
        HTTPS[HTTP Endpoints]
        AUTH[Token Auth]
        EVT[Event Bus]
    end

    subgraph Clients
        WEBCLI[Web UI Client]
        CLICLI[CLI Client]
        MOBCLI[Mobile App Client]
        BOTCLI[Channel Bots]
    end

    Clients -->|WS + Token| WSS
    Clients -->|REST| HTTPS
    WSS --> AUTH --> EVT
    HTTPS --> AUTH
```

**Key properties:**
- **Default bind:** `127.0.0.1:18789` (loopback only for security)
- **Configurable bind modes:** `local`, `lan`, `remote`
- **Max payload:** 25MB (for large LLM responses)
- **Heartbeat interval:** 30 seconds
- **Client modes:** `BACKEND`, `EMBEDDED`, `WEB_UI`
- **Authentication:** Token-based with device identity signing + TLS fingerprint validation

**Entry points:**

| File | Purpose |
|------|---------|
| `src/index.ts` | Main CLI bootstrapper — loads env, validates runtime, builds Commander program |
| `src/entry.ts` | Process-level bootstrap — respawn guards, Windows compat, error handlers |
| `src/gateway/client.ts` | `GatewayClient` class — WS connection with auto-reconnect and request/response correlation |
| `src/gateway/boot.ts` | Boot sequence — reads optional `BOOT.md` and runs startup instructions |

### 3.2 CLI Interface

OpenClaw provides a comprehensive CLI built with Commander.js:

```
openclaw
├── gateway         # Start/manage the gateway
├── onboard         # First-time setup wizard
├── agent           # Run agent commands
├── channels        # Channel management & status
├── config          # Configuration management
├── doctor          # Diagnostic checks
├── cron            # Scheduled task management
├── plugins         # Plugin management
├── nodes           # Node device management
├── message         # Send messages programmatically
├── logs            # View structured logs
├── dashboard       # Terminal dashboard
└── update          # Update to stable/beta/dev channel
```

### 3.3 Build System

```mermaid
graph LR
    TS["TypeScript Source<br/>src/**/*.ts"] -->|tsdown| JS["JavaScript<br/>dist/**/*.js"]
    JS -->|node| RUN[Runtime]

    REACT["React UI<br/>ui/src/"] -->|vite| STATIC["Static Assets<br/>ui/dist/"]

```

| Tool | Purpose |
|------|---------|
| `tsdown` | TypeScript bundler (ESM output) |
| `tsx` | TypeScript executor for development |
| `oxlint` | Rust-based linter |
| `oxfmt` | Rust-based formatter |
| `vitest` | Test runner with V8 coverage |
| `vite` | React UI bundler |

---

## 4. Voice Pipeline (Cheeko)

The voice system ("Cheeko") provides real-time voice conversations via a custom WebSocket-based pipeline built entirely in Node.js/TypeScript. Clients connect over WebSocket, send Opus or PCM audio frames, and receive spoken responses back as audio frames.

### 4.1 Voice Architecture

```mermaid
sequenceDiagram
    participant Client as Browser / Native Client
    participant WS as Gateway<br/>/cheeko/stream
    participant STT as Deepgram STT<br/>(Nova-2 streaming)
    participant AGENT as Agent Runtime<br/>(LLM dispatch)
    participant TTS as TTS Provider<br/>(OpenAI / ElevenLabs)

    Client->>WS: WS connect
    WS-->>Client: { type: "hello_ack" }

    loop Voice Conversation
        Client->>WS: Binary audio frames<br/>(Opus or PCM)
        WS->>STT: Stream audio to Deepgram
        STT-->>WS: Interim transcripts
        WS-->>Client: { type: "transcript", isFinal: false }
        Client->>WS: { type: "speech_end" }
        STT-->>WS: Final transcript
        WS-->>Client: { type: "transcript", isFinal: true }
        WS->>AGENT: dispatchInboundMessage(transcript)
        AGENT-->>WS: Streamed text (sentence chunks)
        WS->>TTS: Synthesize each sentence
        TTS-->>WS: PCM audio data
        WS->>WS: Opus encode (OpusScript)
        WS-->>Client: Binary Opus/PCM audio frames
    end
```

### 4.2 Cheeko Stream Handler

The voice pipeline is implemented across five files in `src/gateway/`:

| File | Purpose |
|------|---------|
| `cheeko-stream.ts` | WebSocket server, per-connection session state, audio routing |
| `cheeko-stt.ts` | Deepgram SDK integration — streaming STT with VAD events |
| `cheeko-chat.ts` | Bridges transcript to agent runtime, sentence-buffered response streaming |
| `cheeko-tts.ts` | OpenAI TTS provider + Opus encoding (OpusScript) |
| `cheeko-tts-elevenlabs.ts` | ElevenLabs TTS provider + Opus encoding |

```mermaid
graph TD
    subgraph cheeko-stream.ts
        WSS["WebSocket Server<br/>/cheeko/stream"]
        SESSION[Per-Connection Session<br/>CheekStreamSession]
    end

    subgraph cheeko-stt.ts
        DG["Deepgram Client<br/>@deepgram/sdk"]
        LIVE[Live Transcription<br/>Nova-2 streaming]
    end

    subgraph cheeko-chat.ts
        DISPATCH[dispatchInboundMessage]
        SENTBUF[Sentence Buffer<br/>split on . ! ?]
    end

    subgraph "cheeko-tts.ts / cheeko-tts-elevenlabs.ts"
        OPENAITTS[OpenAI TTS API<br/>gpt-4o-mini-tts]
        ELEVENTTS[ElevenLabs API<br/>eleven_turbo_v2]
        OPUS[OpusScript Encoder<br/>24kHz, 32kbps VOIP]
    end

    WSS --> SESSION
    SESSION -->|audio frames| DG --> LIVE
    LIVE -->|transcript| DISPATCH --> SENTBUF
    SENTBUF -->|sentence| OPENAITTS --> OPUS --> WSS
    SENTBUF -->|sentence| ELEVENTTS --> OPUS
```

### 4.3 Per-Connection Session

Each WebSocket connection creates a `CheekStreamSession`:

```typescript
type CheekStreamSession = {
  sessionId: string
  deviceId: string
  ws: WebSocket
  state: "idle" | "listening" | "processing" | "speaking"
  chatHistory: Array<{ role: string; content: string }>
  audioFormat: "opus" | "pcm"     // opus for native, pcm for web
  sttStream: CheekSttStream | null
  finalTranscript: string
  chatHandle: CheekChatHandle | null
  ttsPipeline: CheekTtsPipeline | null
  speechEndAt: number             // for latency measurement
  firstAudioSent: boolean
}
```

### 4.4 STT — Deepgram Integration

The STT module (`cheeko-stt.ts`) uses the Deepgram SDK for streaming transcription:

- **Provider:** Deepgram Nova-2 (configurable model)
- **Encoding:** Opus (native clients) or Linear16/PCM (web clients)
- **Sample rate:** 16kHz, mono
- **Features:** Punctuation, interim results, endpointing (300ms), utterance end (1000ms), VAD events, smart formatting
- **API key:** Via config (`deepgramApiKey`) or `DEEPGRAM_API_KEY` env var

### 4.5 TTS — Multi-Provider Support

TTS is selected per-connection based on `config.ttsProvider`:

| Provider | Module | Audio Format | Key Config |
|----------|--------|-------------|------------|
| **OpenAI** (default) | `cheeko-tts.ts` | PCM 24kHz → Opus | `openaiApiKey`, voice selection |
| **ElevenLabs** | `cheeko-tts-elevenlabs.ts` | PCM 24kHz → Opus | `elevenlabsApiKey`, `elevenlabsVoiceId`, `elevenlabsModelId` |
| **Edge TTS** | `node-edge-tts` (core dep) | Via native apps / talk extension | Built-in, no API key needed |

Both OpenAI and ElevenLabs TTS modules:
1. Request PCM audio (24kHz, 16-bit mono) from the provider
2. Encode to Opus frames using OpusScript (32kbps, VOIP mode, 20ms frames)
3. Deliver frames to the client via WebSocket

### 4.6 Chat Bridge

The chat module (`cheeko-chat.ts`) bridges voice transcripts to the agent runtime:

1. Receives final transcript text
2. Creates a `MsgContext` and calls `dispatchInboundMessage` (same path as text channels)
3. Subscribes to agent events for streamed response
4. Accumulates text deltas into a **sentence buffer** (splits on `.` `!` `?`)
5. Fires `onTextChunk` for each complete sentence (triggers TTS)
6. Fires `onComplete` when the full response is done
7. Registers conversation in `default#voice` session key

### 4.7 WebSocket Protocol

**Endpoint:** `WS /cheeko/stream`

**Client → Server:**

| Type | Format | Description |
|------|--------|-------------|
| `hello` | JSON | `{ type: "hello", deviceId?: string, token?: string, clientType?: string }` |
| `speech_end` | JSON | `{ type: "speech_end" }` — signals end of user utterance |
| `cancel` | JSON | `{ type: "cancel" }` — abort current response |
| Audio frames | Binary | Raw Opus or PCM audio data |

**Server → Client:**

| Type | Format | Description |
|------|--------|-------------|
| `hello_ack` | JSON | Connection acknowledged |
| `status` | JSON | `{ type: "status", stage: "listening" | "processing" | "speaking" }` |
| `transcript` | JSON | `{ type: "transcript", text: string, isFinal: boolean }` |
| `error` | JSON | `{ type: "error", message: string }` |
| Audio frames | Binary | Opus or PCM response audio |

### 4.8 Voice-Call Extension (Telephony)

The `extensions/voice-call/` extension adds telephone voice support via SIP/PSTN providers:

- **Providers:** Twilio, Telnyx, Plivo (pluggable)
- **Features:** Inbound/outbound calls, TTS response generation, webhook security
- **Architecture:** Provider adapters implement a common `base.ts` interface
- **TTS:** Dedicated `telephony-tts.ts` with OpenAI TTS for phone calls

---

## 5. Multi-Channel Messaging

### 5.1 Channel Architecture

OpenClaw uses an **adapter pattern** where each messaging platform implements a common `ChannelPlugin` interface. Channels are split into two tiers:

- **Core chat channels** — registered in `src/channels/registry.ts` (`CHAT_CHANNEL_ORDER`), with protocol logic in `src/<channel>/` and docks hard-coded in `src/channels/dock.ts`
- **Extension channels** — loaded at runtime from `extensions/`, registered via the plugin system

```mermaid
graph TD
    subgraph CoreCh["Core Chat Channels (src/channels/registry.ts)"]
        TG["Telegram<br/>grammY · src/telegram/"]
        WA["WhatsApp<br/>Baileys · src/whatsapp/ + src/web/"]
        DC["Discord<br/>discord.js · src/discord/"]
        IR["IRC<br/>src/ + extensions/irc/"]
        GC["Google Chat<br/>extensions/googlechat/"]
        SL["Slack<br/>@slack/bolt · src/slack/"]
        SG["Signal<br/>signal-cli · src/signal/"]
        IM["iMessage<br/>imsg bridge · src/imessage/"]
    end

    subgraph ExtCh["Extension-Only Channels (extensions/)"]
        MT[MS Teams]
        MX[Matrix]
        LN[LINE]
        BB[BlueBubbles]
        ZL["Zalo / Zalo Personal"]
        MM[Mattermost]
        NC[Nextcloud Talk]
        TW[Twitch]
        FE["Feishu / Lark"]
        NS[Nostr]
        TL[Tlon]
    end

    subgraph Infra["Channel Infrastructure (src/channels/)"]
        DOCK[Channel Dock<br/>dock.ts]
        REG[Channel Registry<br/>registry.ts]
        PLUG["Plugin Loader<br/>plugins/index.ts"]
        DISP[Dispatch Router]
    end

    CoreCh --> DOCK
    ExtCh --> PLUG
    DOCK --> REG --> DISP
    PLUG --> DISP
```

**Default channel:** WhatsApp (`DEFAULT_CHAT_CHANNEL = "whatsapp"`)

### 5.2 Channel Dock Interface

Each channel implements a `ChannelDock` — a lightweight descriptor:

```typescript
ChannelDock {
  id: ChannelId                    // e.g., "telegram", "discord"
  capabilities: {
    chatTypes: ("direct" | "group" | "channel" | "thread")[]
    nativeCommands: boolean        // slash command support
    blockStreaming: boolean        // can receive streamed text
  }
  outbound?: {
    textChunkLimit?: number        // max message length
  }
  elevated?: ...                   // admin features
  config?: ...                     // channel-specific config
  groups?: ...                     // group management
  mentions?: ...                   // @mention handling
  threading?: ...                  // thread/reply support
  agentPrompt?: ...                // channel-specific system prompt
}
```

### 5.3 Channel Plugin Interface

Full plugin adapters extend the dock with richer functionality:

```typescript
ChannelPlugin {
  id: ChannelId
  meta: { name, description, version }
  capabilities: ChannelCapabilities

  // Adapters (optional — implement what you need)
  commands?: ChannelCommandAdapter      // CLI commands
  messaging?: ChannelMessagingAdapter   // Send/receive messages
  outbound?: ChannelOutboundAdapter     // Outbound delivery
  elevated?: ChannelElevatedAdapter     // Admin operations
  groups?: ...                          // Group management
  mentions?: ...                        // @mention resolution
  threading?: ...                       // Thread/reply handling
  status?: ...                          // Health check
  setup?: ...                           // First-time setup
  auth?: ...                            // Authentication
  pairing?: ...                         // DM pairing codes
}
```

### 5.4 Message Flow

```mermaid
flowchart TD
    IN[Inbound Message<br/>from any channel] --> NORM[Normalize Channel<br/>+ Session Key]
    NORM --> DISP[dispatchInboundMessage]
    DISP --> REPLY[getReplyFromConfig]

    REPLY --> CFG[Load Config<br/>+ Agent Scope]
    CFG --> MODEL[Resolve Model<br/>with fallback chain]
    MODEL --> SKILLS[Merge Skill Filters<br/>channel + agent]
    SKILLS --> SESSION[Initialize Session]
    SESSION --> MEDIA[Process Media<br/>images, links, files]
    MEDIA --> AGENT[Execute Agent Run<br/>with timeout]
    AGENT --> PAYLOAD[Reply Payload]

    PAYLOAD --> RD[Reply Dispatcher]
    RD --> FORMAT[Apply Formatting<br/>+ Chunk Splitting]
    FORMAT --> OUT[Outbound via<br/>Channel Adapter]
```

### 5.5 DM Pairing & Security

Channels support a **pairing code** mechanism for unknown senders:

1. Unknown sender sends a DM
2. OpenClaw replies with a pairing code
3. User enters the code via CLI or web UI
4. Sender is added to the allow list
5. Future messages are processed normally

**DM policies:**
- `pairing` (default) — requires code approval
- `open` — accept all DMs (requires explicit opt-in)
- `closed` — reject all unknown DMs

---

## 6. Agent & LLM Orchestration

### 6.1 Agent Runtime

OpenClaw uses the **Pi agent framework** (`@mariozechner/pi-agent-core`) for LLM orchestration:

```mermaid
graph TD
    CMD[Agent Command] --> RESOLVE[Resolve Agent ID<br/>from session key]
    RESOLVE --> LOAD[Load Agent Config<br/>+ Workspace]
    LOAD --> AUTH[Initialize Auth<br/>Profiles]
    AUTH --> MODEL[Resolve Model<br/>with fallbacks]
    MODEL --> WORKSPACE[Ensure Workspace<br/>Directories]
    WORKSPACE --> RUN[Run Agent<br/>Pi Framework]
    RUN --> TOOLS[Execute Tools<br/>via Skills]
    RUN --> EVENTS[Emit Agent Events]
    RUN --> DELIVER[Deliver Result<br/>to Channel]
```

### 6.2 Multi-Agent Routing

OpenClaw supports multiple agents, each with their own configuration:

```mermaid
graph LR
    SK[Session Key<br/>agentId#channelId#targetId] --> SCOPE[Agent Scope<br/>Resolution]

    SCOPE --> A1[Agent: default<br/>Claude Opus]
    SCOPE --> A2[Agent: coding<br/>Claude Sonnet]
    SCOPE --> A3[Agent: support<br/>GPT-4o]

    A1 --> W1["Workspace 1<br/>~/.openclaw/agents/default/"]
    A2 --> W2["Workspace 2<br/>~/.openclaw/agents/coding/"]
    A3 --> W3["Workspace 3<br/>~/.openclaw/agents/support/"]
```

**Session key format:** `agentId#channelId#targetId` or `agentId#sessionId`

**Resolution order:**
1. Extract agent ID from session key
2. Fall back to default agent
3. Resolve agent config (model, skills, tools, temperature)

### 6.3 LLM Provider Support

```mermaid
graph TD
    REQ[Chat Completion Request] --> GW["OpenClaw Gateway<br/>/v1/chat/completions"]

    GW --> ROUTE{Model Router}

    ROUTE -->|claude-*| ANT["Anthropic API<br/>Pro/Max subscription"]
    ROUTE -->|gpt-*| OAI[OpenAI API]
    ROUTE -->|gemini-*| GOO[Google Gemini API]
    ROUTE -->|local:*| OLL[Ollama<br/>Local models]
    ROUTE -->|bedrock:*| AWS[AWS Bedrock]
```

**Key features:**
- OpenAI-compatible API endpoint (`/v1/chat/completions`)
- Model fallback chains (try primary, fall back to secondary)
- Per-agent model configuration
- Subscription-based auth (Anthropic Pro/Max, OpenAI ChatGPT)

### 6.4 Skills & Tools

OpenClaw includes 60+ built-in skills (tools available to the agent):

| Category | Skills |
|----------|--------|
| **Browser** | Web browsing, screenshots, form filling |
| **Canvas** | Live A2UI rendering, interactive visual workspace |
| **Coding** | Code generation, file editing, terminal commands |
| **Apple Notes** | Read/write Apple Notes |
| **1Password** | Password manager integration |
| **Media** | Image processing (Sharp), PDF parsing, audio processing |
| **Communication** | Send messages across channels |
| **Automation** | Cron jobs, webhooks, HTTP requests |
| **Memory** | Vector-based memory (LanceDB) |

---

## 7. Plugin & Extension System

### 7.1 Plugin Architecture

```mermaid
graph TD
    subgraph PlugReg["Plugin Registry"]
        PR[PluginRegistry<br/>Global Singleton]
        PR --> TOOLS[Tool Registrations]
        PR --> HOOKS[Hook Registrations]
        PR --> CHANNELS[Channel Registrations]
        PR --> PROVIDERS[Provider Registrations]
        PR --> SERVICES[Service Registrations]
        PR --> GWH[Gateway Handlers]
        PR --> HTTPH["HTTP Handlers/Routes"]
        PR --> CLIR[CLI Registrars]
        PR --> DIAG[Diagnostics]
    end

    subgraph PlugSrc["Plugin Sources"]
        BUILTIN["Built-in<br/>skills/"]
        EXT["Extensions<br/>extensions/"]
        CUSTOM["User Plugins<br/>~/.openclaw/plugins/"]
    end

    PlugSrc -->|load & register| PR
```

### 7.2 Plugin Record

Each loaded plugin is tracked as a `PluginRecord`:

```typescript
PluginRecord {
  id: string
  name: string
  version: string
  kind: "skill" | "extension" | "channel"
  source: string           // file path
  origin: "built-in" | "custom"
  enabled: boolean
  status: "loaded" | "disabled" | "error"
  toolNames: string[]
  hookNames: string[]
  channelIds: string[]
  providerIds: string[]
  configSchema?: ZodSchema
  configUiHints?: object
}
```

### 7.3 Extension Development

Extensions live in `extensions/` as workspace packages:

```
extensions/
├── discord/          # Discord channel extension
├── telegram/         # Telegram channel extension
├── slack/            # Slack channel extension
├── msteams/          # Microsoft Teams
├── matrix/           # Matrix protocol
├── whatsapp/         # WhatsApp (Baileys)
├── signal/           # Signal protocol
├── voice-call/       # Voice calling
├── memory-core/      # Memory subsystem
├── memory-lancedb/   # Vector DB for memory
└── [30+ more]
```

**Rules for extension development** (from AGENTS.md):
- Keep plugin-only dependencies in the extension's own `package.json`
- Do not add plugin deps to root `package.json` unless core uses them
- Plugin install runs `npm install --omit=dev` in the plugin directory
- Avoid `workspace:*` in dependencies (breaks npm install)
- Put `openclaw` in `devDependencies` or `peerDependencies`
- Runtime resolves `openclaw/plugin-sdk` via jiti alias

---

## 8. Configuration System

### 8.1 Config Architecture

```mermaid
graph TD
    ENV[.env.local<br/>Secrets & env vars] --> LOAD[loadConfig]
    CFG["~/.openclaw/openclaw.json<br/>Main config file"] --> LOAD
    CLI[CLI flags<br/>--port, --bind, etc.] --> LOAD

    LOAD --> PARSE[JSON5/YAML Parser]
    PARSE --> VALIDATE[Zod Schema<br/>Validation]
    VALIDATE --> RESOLVED[Resolved Config<br/>OpenClawConfig]

    RESOLVED --> GW[Gateway]
    RESOLVED --> AG[Agent Runtime]
    RESOLVED --> CH[Channel Adapters]
```

### 8.2 Config Schema

The configuration is validated using **Zod schemas** spread across modular type files:

```
src/config/
├── config.ts              # loadConfig, createConfigIO, writeConfigFile
├── types.ts               # Root export hub
├── types.agents.ts        # Agent definitions, models, skills
├── types.channels.ts      # Channel-specific config
├── types.discord.ts       # Discord-specific
├── types.slack.ts         # Slack-specific
├── types.telegram.ts      # Telegram-specific
├── types.gateway.ts       # Gateway settings
├── types.tools.ts         # Tool definitions
├── types.plugins.ts       # Plugin configuration
└── [15+ more type modules]
```

### 8.3 Sample Configuration

```yaml
gateway:
  port: 18789
  bind: "lan"
  http:
    endpoints:
      chatCompletions:
        enabled: true

agents:
  - id: "default"
    model: "claude-opus-4.6"
    temperature: 0.7
    skills:
      enabled: ["browser", "canvas", "coding-agent"]

channels:
  telegram:
    enabled: true
    token: "YOUR_BOT_TOKEN"
    dmPolicy: "pairing"
    allowFrom: ["123456789"]
  discord:
    enabled: true
    token: "YOUR_DISCORD_TOKEN"
  whatsapp:
    enabled: true

talk:
  enabled: true
  apiKey: "YOUR_ELEVENLABS_KEY"
  voices: ["21m00Tcm4TlvDq8ikWAM"]
```

### 8.4 Config Storage Locations

| Path | Purpose |
|------|---------|
| `~/.openclaw/openclaw.json` | Main configuration (YAML/JSON) |
| `~/.openclaw/credentials/` | Encrypted provider credentials |
| `~/.openclaw/sessions/` | Persisted session data (SQLite) |
| `~/.openclaw/agents/` | Per-agent workspace directories |
| `~/.openclaw/plugins/` | User-installed plugins |
| `.env.local` | Environment secrets (gitignored) |

---

## 9. Session & State Management

### 9.1 Session Model

```mermaid
graph TD
    SK[Session Key] --> SID[Session ID]
    SK --> AID[Agent ID]
    SK --> CID[Channel ID]
    SK --> TID[Target ID]

    SID --> SS[Session Store<br/>SQLite]
    SS --> MSGS[Message History]
    SS --> CTX[Context State]
    SS --> META[Metadata]
```

**Session key format:** `agentId#channelId#targetId`

**Session kinds:**
- `main` — primary user conversation
- `group` — group chat session
- `cron` — scheduled task session
- `hook` — webhook-triggered session
- `node` — device node session
- `other` — custom sessions

### 9.2 Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Created: New message from<br/>unknown session key
    Created --> Active: Agent processes<br/>first message
    Active --> Active: Ongoing conversation
    Active --> Idle: No activity<br/>(timeout)
    Idle --> Active: New message
    Active --> Archived: Explicit close
    Archived --> [*]
```

### 9.3 State Persistence

- **Session store:** SQLite in `~/.openclaw/sessions/`
- **Per-agent isolation:** Each agent has its own workspace directory
- **Concurrency control:** Configurable max concurrent messages per agent
- **Queue mode:** Messages can be queued when agent is busy

---

## 10. Security Architecture

### 10.1 Security Layers

```mermaid
graph TD
    subgraph Transport
        TLS["TLS/WSS<br/>for remote connections"]
        LOOP[Loopback Bind<br/>127.0.0.1 default]
    end

    subgraph Authentication
        TOKEN[Gateway Token<br/>OPENCLAW_GATEWAY_TOKEN]
        DEVICE[Device Identity<br/>Signing]
        PAIR[DM Pairing<br/>Approval codes]
        OAUTH[OAuth Providers<br/>Anthropic, OpenAI]
    end

    subgraph Authorization
        ALLOW[Per-channel Allowlists]
        DM["DM Policy<br/>pairing/open/closed"]
        ROLE[Role-based<br/>Access Control]
    end

    subgraph DataProt["Data Protection"]
        LOCAL[Local-first Storage]
        CRED["Encrypted Credentials<br/>~/.openclaw/credentials/"]
        SANDBOX[Docker Sandbox<br/>for code execution]
        NONROOT[Non-root Container<br/>uid 1000]
    end

    Transport --> Authentication --> Authorization --> DataProt
```

### 10.2 Security Defaults

| Setting | Default | Notes |
|---------|---------|-------|
| Gateway bind | `127.0.0.1` (loopback) | Must explicitly opt into LAN/remote |
| DM policy | `pairing` | Unknown senders get approval code |
| Docker user | `node` (uid 1000) | Non-root execution |
| Config permissions | User-only readable | `~/.openclaw/` directory |
| Transport | Plain WS locally, WSS required for remote | TLS fingerprint validation |
| Code execution | Sandboxed (Docker) | Optional, opt-in |

### 10.3 Credential Management

- **Provider API keys:** Stored in `~/.openclaw/credentials/` (encrypted)
- **Channel tokens:** In main config file (user-readable only)
- **OAuth sessions:** Per-provider in credentials directory
- **Environment secrets:** `.env.local` (gitignored, never committed)

---

## 11. Data Models & Key Types

### 11.1 Core TypeScript Types

```typescript
// Session
type Session = {
  id: string
  userId: string
  kind: "main" | "group" | "cron" | "hook" | "node" | "other"
  messages: Message[]
  context: object
  metadata: SessionMetadata
  activationMode?: string
  queueMode?: string
}

// Message
type Message = {
  id: string
  sender: string
  channelId: ChannelId
  content: string
  attachments?: Attachment[]
  timestamp: number
  inReplyTo?: string
  reactions?: Record<string, string[]>
}

// Attachment
type Attachment = {
  type: "image" | "video" | "audio" | "file"
  data: Buffer
  mimeType: string
  url?: string
  metadata?: object
}

// Agent Configuration
type AgentConfig = {
  model: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  tools?: Tool[]
  thinking?: "none" | "low" | "medium" | "high"
}
```

### 11.2 Voice Stream Protocol

```typescript
// Cheeko WebSocket messages
type CheekStreamMessage =
  | { type: "hello"; deviceId: string }
  | { type: "audio"; opusFrame: Buffer }
  | { type: "audio_end" }
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "audio_ready"; opusFrame: Buffer }
  | { type: "error"; message: string }
  | { type: "close" }
```

### 11.3 Plugin Registry Types

```typescript
type PluginRegistry = {
  plugins: PluginRecord[]
  tools: PluginToolRegistration[]
  hooks: PluginHookRegistration[]
  channels: PluginChannelRegistration[]
  providers: PluginProviderRegistration[]
  services: PluginServiceRegistration[]
  gatewayHandlers: GatewayRequestHandlers
  httpHandlers: HttpHandler[]
  httpRoutes: HttpRoute[]
  cliRegistrars: CLIRegistrar[]
  commands: PluginCommandDefinition[]
  diagnostics: PluginDiagnostic[]
}
```

---

## 12. API Reference

### 12.1 HTTP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/chat/completions` | POST | OpenAI-compatible LLM endpoint |
| `/cheeko/stream` | WS | Voice streaming (Opus/PCM audio + JSON control) |
| `/gateway/config` | GET | Configuration management |
| `/gateway/status` | GET | Health check & status |
| `/sessions` | GET/POST | Session list & management |
| `/sessions/{id}` | GET/PUT/DELETE | Individual session operations |
| `/messages` | POST | Send message to session |
| `/channels` | GET | List active channels |
| `/channels/{id}/send` | POST | Send to specific channel |
| `/control-ui` | GET/WS | Control interface & real-time updates |
| `/webhooks/*` | POST | Webhook delivery & event streaming |

### 12.2 WebSocket Protocols

**Gateway Control Plane (port 18789):**
- Real-time events, presence updates, config reloads
- Request/response correlation via sequence numbers
- Used by CLI, web UI, mobile apps

**Cheeko Voice Stream (`/cheeko/stream`):**
- Binary: Opus audio frames (16kHz 16-bit mono)
- Text: JSON control messages
- Handshake: `{ type: "hello", deviceId: "..." }`

### 12.3 Cheeko Voice Stream API

See [Section 4.7](#47-websocket-protocol) for the full WebSocket protocol reference (message types, audio framing, and control flow).

---

## 13. Frontend & Native Apps

### 13.1 Web UI

```mermaid
graph TD
    subgraph WebUI["Web UI (React + Vite)"]
        ROUTER[React Router]
        ROUTER --> DASH[Dashboard]
        ROUTER --> SETTINGS[Settings]
        ROUTER --> LOGS[Log Viewer]
        ROUTER --> SESSIONS[Session Manager]
        ROUTER --> VOICE[Voice Interface]
    end

    subgraph Connections
        GWCONN[Gateway WS<br/>Real-time events]
        CHEEKO["Cheeko WS<br/>/cheeko/stream audio"]
    end

    WebUI --> GWCONN
    VOICE --> CHEEKO
```

**Stack:** React + TypeScript, Vite bundler

### 13.2 Native Apps

| Platform | Technology | Features |
|----------|-----------|----------|
| **macOS** | Swift/SwiftUI | Menu bar app, Canvas (A2UI), Voice Wake, gateway management |
| **iOS** | Swift/SwiftUI | Companion node, Canvas, Voice, push notifications |
| **Android** | Kotlin | Companion node, Canvas, Talk mode, WebView |

**macOS specifics:**
- Gateway runs as menu bar app (not a separate LaunchAgent)
- Uses Observation framework (`@Observable`, `@Bindable`)
- WebKit embed for web-based views
- Voice Wake for hands-free activation

### 13.3 Canvas (A2UI)

A live, interactive visual workspace that the agent can render:
- Real-time rendering of agent-generated UI
- Interactive components (forms, charts, visualizations)
- Available on macOS, iOS, and Android

---

## 14. Deployment Architecture

### 14.1 Deployment Options

```mermaid
graph TD
    subgraph Local
        NPM[npm install -g openclaw]
        SRC[Source: pnpm build]
        NIX[Nix package]
    end

    subgraph Container
        DOCKER[Docker<br/>node:22-bookworm]
        COMPOSE[Docker Compose<br/>gateway + CLI]
    end

    subgraph Cloud
        FLY[Fly.io<br/>shared-cpu-2x, 2GB RAM]
        RENDER[Render<br/>Blueprint]
        SYSTEMD["systemd/launchd<br/>Daemon service"]
    end

    Local --> RUN[OpenClaw Runtime]
    Container --> RUN
    Cloud --> RUN
```

### 14.2 Docker Image

```dockerfile
# Base: node:22-bookworm
# Installs: Bun (optional), corepack (pnpm)
# Build: pnpm install → pnpm build → pnpm ui:build
# Runtime: Non-root (node, uid 1000)
# CMD: node openclaw.mjs gateway --allow-unconfigured
```

### 14.3 Docker Compose

Two services:
- **openclaw-gateway:** The control plane (ports 18789, 18790)
- **openclaw-cli:** Interactive CLI (tty enabled)

Volumes mount `~/.openclaw/` for persistent config and workspaces.

### 14.4 Fly.io

- **Region:** `iad` (US East)
- **VM:** `shared-cpu-2x`, 2048MB RAM
- **Storage:** Persistent volume at `/data`
- **Port:** 3000 (internal), HTTPS forced
- **Node options:** `--max-old-space-size=1536`
- **Auto-stop:** Disabled (persistent WebSocket connections)

### 14.5 Port Mapping

| Port | Service | Notes |
|------|---------|-------|
| 18789 | Gateway control plane + Cheeko voice | Default, configurable |
| 18790 | Bridge (optional) | Secondary connections |
| 3000 | Fly.io HTTP | Cloud deployment only |

---

## 15. Development Workflow

### 15.1 Setup

```bash
# Clone and install
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install

# Build everything
pnpm build
pnpm ui:build

# First-time setup
pnpm openclaw onboard --install-daemon
```

### 15.2 Development Commands

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install all dependencies |
| `pnpm build` | TypeScript → JavaScript (tsdown) |
| `pnpm check` | Format (oxfmt) + lint (oxlint) + type-check |
| `pnpm test` | Run vitest test suite |
| `pnpm test:coverage` | Coverage report (70% threshold) |
| `pnpm gateway:watch` | Auto-reload gateway on changes |
| `pnpm ui:dev` | Vite dev server for web UI |
| `pnpm openclaw ...` | Run CLI via tsx |

### 15.3 Coding Conventions

- **Language:** TypeScript (ESM), strict mode, no `any`
- **Formatting:** oxlint + oxfmt (Rust-based, fast)
- **File size:** ~700 LOC guideline (not a hard limit)
- **Comments:** Brief, only for tricky logic
- **Naming:** "OpenClaw" in docs, `openclaw` in code/config
- **Tests:** Colocated `*.test.ts` files, Vitest + V8 coverage

### 15.4 Commit & PR Workflow

- Use `scripts/committer "<msg>" <file...>` for commits
- Concise, action-oriented commit messages
- Full PR workflow documented in `.agents/skills/PR_WORKFLOW.md`
- Pre-commit hooks via `prek install`

---

## 16. Observability & Diagnostics

### 16.1 Logging

- **Framework:** tslog (structured logging)
- **Console capture:** `enableConsoleCapture()` at startup
- **CLI access:** `openclaw logs`

### 16.2 Diagnostics

```bash
# Comprehensive health check
openclaw doctor

# Channel connectivity probe
openclaw channels status --probe

# Gateway health
openclaw gateway status

# HTTP health endpoint
GET /gateway/status
```

### 16.3 Monitoring

- **OpenTelemetry:** Optional via `otel` extension
- **Terminal dashboard:** `openclaw dashboard`
- **Session inspector:** Via web UI or CLI

---

## 17. Roadmap & Future Directions

### Active Development

- **Voice pipeline maturation:** Latency optimization, multi-provider TTS benchmarking, turn-taking improvements
- **ElevenLabs TTS integration:** Recently added as configurable alternative to Edge TTS
- **End-to-end voice testing:** Automated test suite for the full STT → LLM → TTS pipeline

### Planned Improvements

- **Voice Wake improvements:** Better wake word detection, lower latency activation
- **Multi-modal support:** Image and document understanding in voice conversations
- **Agent collaboration:** Multiple agents working together on complex tasks
- **Memory system enhancements:** Better long-term memory with vector search (LanceDB)
- **Channel parity:** Ensuring feature consistency across all 40+ channels
- **Plugin marketplace:** Discoverable, installable community plugins

### Architectural Considerations

- **Horizontal scaling:** Moving from single-instance to multi-instance gateway
- **Edge deployment:** Running lightweight agents on edge devices (IoT, Raspberry Pi)
- **Federated architecture:** Multiple OpenClaw instances sharing context
- **Streaming optimization:** Reducing end-to-end voice latency below 500ms

### Known Technical Debt

- Large TypeScript source (~340k LOC) — ongoing modularization
- Extension install uses `npm install` (could benefit from unified pnpm)
- Config schema spread across 15+ type files — consolidation opportunity

---

## Appendix A: Directory Structure

```
openclaw/
├── src/                          # Core TypeScript source
│   ├── index.ts                  # CLI entry point
│   ├── entry.ts                  # Process bootstrap
│   ├── gateway/                  # WebSocket control plane
│   ├── channels/                 # Multi-channel adapters
│   ├── config/                   # Config loading & validation
│   ├── agents/                   # Agent runtime & workspaces
│   ├── plugins/                  # Plugin registry & runtime
│   ├── auto-reply/               # Message dispatch & reply
│   ├── commands/                 # CLI command handlers
│   ├── cli/                      # CLI infrastructure
│   ├── media/                    # Image/audio/video processing
│   ├── browser/                  # Playwright browser automation
│   ├── acp/                      # Agent Client Protocol
│   ├── extensions/               # Extension loader
│   ├── hooks/                    # Webhook & event system
│   ├── sandbox/                  # Sandboxed code execution
│   ├── web/                      # Web channel/interface
│   ├── infra/                    # Infrastructure (ports, env)
│   ├── discord/                  # Discord channel core
│   ├── telegram/                 # Telegram channel core
│   ├── slack/                    # Slack channel core
│   ├── signal/                   # Signal channel core
│   ├── imessage/                 # iMessage integration
│   └── logging.ts                # Structured logging
│
├── extensions/                   # Plugin workspace packages (40+)
├── skills/                       # Built-in skills/tools (60+)
├── packages/                     # Workspace packages
│   ├── clawdbot/                 # Multi-channel bot
│   └── moltbot/                  # Alternative bot
│
├── ui/                           # React web UI (Vite)
├── apps/                         # Native applications
│   ├── macos/                    # Swift/SwiftUI menu bar app
│   ├── ios/                      # iOS companion app
│   └── android/                  # Android companion app
│
├── docs/                         # Documentation (Mintlify)
├── scripts/                      # Build & automation scripts
├── test/                         # Test suites
├── dist/                         # Compiled output
│
├── package.json                  # Main dependencies
├── pnpm-workspace.yaml           # Monorepo workspace config
├── tsconfig.json                 # TypeScript config
├── Dockerfile                    # Container image
├── docker-compose.yml            # Multi-service orchestration
├── fly.toml                      # Fly.io deployment
└── render.yaml                   # Render deployment
```

## Appendix B: Dependency Map

```mermaid
graph TD
    subgraph Node.js Core
        EXPRESS[express 5.2]
        WS[ws]
        ZOD[zod 4.3]
        COMMANDER[commander]
    end

    subgraph AI/ML
        OPENAI[openai 6.21]
        PI[pi-agent-core 0.52]
        OLLAMA[ollama 0.6]
        BEDROCK["@aws-sdk/bedrock 3.988"]
    end

    subgraph Channels
        GRAMMY[grammY 1.40]
        DISCORDJS[discord.js]
        SLACKBOLT["@slack/bolt 4.6"]
        BAILEYS[baileys 7.0]
        LINESDK["@line/bot-sdk 10.6"]
    end

    subgraph Media
        SHARP[sharp 0.34]
        PLAYWRIGHT[playwright 1.58]
        OPUS[opusscript]
        EDGETTS[node-edge-tts 1.2]
    end

    subgraph Voice
        DEEPGRAMSDK["@deepgram/sdk"]
        OPUSSCRIPT[opusscript]
    end

    EXPRESS --> ZOD
    PI --> OPENAI
    DEEPGRAMSDK --> OPUSSCRIPT
```

## Appendix C: Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | Yes (remote) | Gateway authentication token |
| `DEEPGRAM_API_KEY` | Cheeko voice | Deepgram STT API key |
| `OPENAI_API_KEY` | Optional | OpenAI API key (LLM + TTS) |
| `ELEVENLABS_API_KEY` | Optional | ElevenLabs TTS API key |
| `XI_API_KEY` | Optional | ElevenLabs TTS API key (alias) |
| `CLAUDE_AI_SESSION_KEY` | Optional | Anthropic session key |

---

*This document is maintained alongside the codebase. For the latest updates, see the [docs/](.) directory and [AGENTS.md](../AGENTS.md).*
