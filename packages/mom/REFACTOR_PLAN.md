# Mom Refactor Plan

Issue: https://github.com/badlogic/pi-mono/issues/412
Branch: `refactor/mom-adapter-architecture`

## Goals

1. **Adapter 架構** — agent core 與 chat platform 解耦，支援 Slack / Discord / 未來其他平台
2. **Thread-based session** — Slack thread 作為 session 邊界，支援同 channel 多對話並發
3. **Multi-provider** — 解除 Anthropic 鎖定，透過 config 切換 AI provider/model

---

## Current Architecture

```
main.ts ─── SlackBot (slack.ts)
         │     ├── SocketMode event handlers
         │     ├── Channel backfill
         │     └── ChannelQueue (per-channel, serial)
         │
         ├── createSlackContext() ──→ SlackContext (Slack-specific interface)
         │
         └── AgentRunner (agent.ts)
               ├── hardcoded: getModel("anthropic", "claude-sonnet-4-5")
               ├── hardcoded: getAnthropicApiKey()
               ├── SlackContext as run() parameter
               ├── Slack mrkdwn in system prompt
               └── session key = channelId (one session per channel)
```

### Files & Responsibilities (current)

| File | Lines | Role | Coupling |
|------|-------|------|----------|
| `slack.ts` | 623 | Slack connection, events, backfill | Slack-only |
| `agent.ts` | 885 | Agent runner, system prompt, session management | Slack + Anthropic |
| `main.ts` | 368 | Entrypoint, SlackContext creation, handler | Slack |
| `context.ts` | 181 | log.jsonl ↔ SessionManager sync | Slack log format |
| `events.ts` | 384 | File-system event watcher | Uses SlackEvent |
| `store.ts` | 235 | Attachment download, log management | Slack token |
| `log.ts` | 272 | Console logging | Neutral |
| `tools/*` | ~755 | bash, read, write, edit, attach | `attach.ts` is Slack-specific |

---

## Target Architecture

```
                    ┌─────────────────────────────┐
                    │         AgentCore            │
                    │  (platform/provider agnostic)│
                    │                              │
                    │  - session management         │
                    │  - tool execution             │
                    │  - memory (MEMORY.md)         │
                    │  - skills                     │
                    │  - events                     │
                    └──────────┬──────────────────┘
                               │ ChatAdapter interface
                    ┌──────────┴──────────────────┐
                    │                              │
              ┌─────┴─────┐              ┌────────┴────────┐
              │   Slack   │              │    Discord      │
              │  Adapter  │              │    Adapter      │
              │           │              │   (future)      │
              │ - threads │              │ - threads       │
              │ - mrkdwn  │              │ - embeds        │
              │ - BlockKit│              │ - slash cmds    │
              └───────────┘              └─────────────────┘
```

---

## Phase 1: Define Interfaces

### 1.1 `ChatAdapter` interface

New file: `src/adapter.ts`

```ts
export interface ChatMessage {
  id: string;              // platform-specific message ID (Slack: ts)
  sessionKey: string;      // adapter-determined session boundary
  userId: string;
  userName?: string;
  text: string;
  attachments?: { name: string; localPath: string }[];
}

export interface ChatResponseContext {
  // Methods the agent can call to respond — platform-agnostic verbs
  respond(text: string): Promise<void>;
  replaceResponse(text: string): Promise<void>;
  respondInThread(text: string): Promise<void>;
  setWorking(working: boolean): Promise<void>;
  uploadFile(filePath: string, title?: string): Promise<void>;
  deleteResponse(): Promise<void>;
}

export interface PlatformInfo {
  name: string;            // "slack" | "discord" | ...
  formattingGuide: string; // injected into system prompt
  channels: { id: string; name: string }[];
  users: { id: string; userName: string; displayName: string }[];
}

export interface ChatAdapter {
  /** Start listening for events */
  start(): Promise<void>;
  /** Stop gracefully */
  stop(): Promise<void>;
  /** Platform info for system prompt injection */
  getPlatformInfo(): PlatformInfo;
}
```

### 1.2 `AgentConfig` — replace hardcoded model/provider

New file or section in existing config:

```ts
export interface AgentConfig {
  provider: string;        // "anthropic" | "openai" | "google" | ...
  model: string;           // "claude-sonnet-4-5" | "gpt-4o" | ...
  thinkingLevel?: string;  // "off" | "low" | ...
}
```

Read from `settings.json` in workspace dir, fallback to env vars or defaults.

---

## Phase 2: Refactor Agent Core

### 2.1 Extract platform-agnostic system prompt builder

**Current**: `agent.ts:141-329` `buildSystemPrompt()` mixes Slack-specific formatting with generic agent instructions.

**Target**: Split into:
- `buildCoreSystemPrompt(workspace, memory, skills, events)` — generic agent capabilities
- Adapter injects `platformInfo.formattingGuide` + channel/user mappings

### 2.2 Replace hardcoded model/provider

**Current** (`agent.ts:27, 45-55`):
```ts
const model = getModel("anthropic", "claude-sonnet-4-5");
async function getAnthropicApiKey(authStorage) { ... }
```

**Target**:
```ts
// Read from workspace settings.json or env
const config = loadAgentConfig(workspaceDir);
const model = getModel(config.provider, config.model);

// Use ModelRegistry.getApiKey(model) instead of hardcoded provider
const agent = new Agent({
  ...,
  getApiKey: async () => {
    const key = await modelRegistry.getApiKey(model);
    if (!key) throw new Error(`No API key for provider: ${model.provider}`);
    return key;
  },
});
```

### 2.3 Change `AgentRunner.run()` signature

**Current**:
```ts
run(ctx: SlackContext, store: ChannelStore, pendingMessages?): Promise<{...}>
```

**Target**:
```ts
run(message: ChatMessage, responseCtx: ChatResponseContext, platform: PlatformInfo): Promise<{...}>
```

---

## Phase 3: Slack Thread Session

### 3.1 Add `thread_ts` to `SlackEvent`

```ts
export interface SlackEvent {
  type: "mention" | "dm";
  channel: string;
  ts: string;
  thread_ts?: string;     // NEW
  user: string;
  text: string;
  files?: [...];
  attachments?: Attachment[];
}
```

### 3.2 Session key derivation

```ts
function getSessionKey(event: SlackEvent): string {
  const rootTs = event.thread_ts ?? event.ts;
  return `${event.channel}:${rootTs}`;
}
```

### 3.3 Per-thread runner/queue

**Current** (`agent.ts:392`): `channelRunners = Map<channelId, AgentRunner>`
**Current** (`slack.ts:136`): `queues = Map<channelId, ChannelQueue>`

**Target**: Key by `sessionKey` instead of `channelId`.

This enables:
- Thread A and Thread B in same channel run concurrently
- Each thread has its own context.jsonl
- "already working" check is per-thread, not per-channel

### 3.4 Directory structure

```
workingDir/
├── {channelId}/
│   ├── MEMORY.md                  # channel-level memory (shared across threads)
│   ├── log.jsonl                  # all channel messages (unchanged)
│   ├── skills/                    # channel-level skills
│   ├── attachments/               # shared attachments
│   ├── sessions/
│   │   ├── {rootTs}/
│   │   │   └── context.jsonl      # per-thread LLM context
│   │   └── {rootTs2}/
│   │       └── context.jsonl
│   └── scratch/                   # shared scratch space
├── MEMORY.md                      # workspace-level memory
├── settings.json                  # agent config (model, provider, etc.)
├── skills/                        # workspace-level skills
└── events/                        # event files
```

Key decisions:
- `MEMORY.md` stays at channel level (shared), NOT per-thread
- `context.jsonl` moves into `sessions/{rootTs}/`
- `log.jsonl` stays at channel level (all messages, for grep)

### 3.5 Reply behavior

All bot replies use `thread_ts = rootTs`:
```ts
// In Slack adapter
await slack.postInThread(channel, rootTs, text);
// NOT postMessage to channel
```

Exception: First response to a non-threaded mention creates the thread (normal Slack behavior).

### 3.6 Session scope config

`settings.json`:
```json
{
  "sessionScope": "thread"
}
```

Values: `"thread"` (default) or `"channel"` (legacy behavior).

### 3.7 Edge case: late join to thread

If bot starts and first event is a thread reply (not the root):
1. Adapter detects `event.thread_ts` exists but session doesn't
2. Fetch thread root via `conversations.replies`
3. Seed session with root message content
4. Then process current message

---

## Phase 4: Slack Adapter Extraction

### 4.1 Move Slack-specific code into `src/adapters/slack/`

```
src/adapters/slack/
├── index.ts        # SlackAdapter implements ChatAdapter
├── bot.ts          # SlackBot (from current slack.ts)
├── context.ts      # createSlackResponseContext (from main.ts createSlackContext)
├── format.ts       # mrkdwn formatting, message splitting
└── backfill.ts     # channel history backfill logic
```

### 4.2 Move `attach.ts` tool into adapter

The `attach` tool is Slack-specific (uploads to Slack). In the adapter model:
- Core tools: bash, read, write, edit (platform-agnostic)
- Platform tools: attach → injected by adapter

---

## Phase 5: Multi-Provider Config

### 5.1 `settings.json` schema

```json
{
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5"
  },
  "sessionScope": "thread"
}
```

### 5.2 Loading priority

1. `settings.json` in workspace dir
2. Environment variables: `MOM_AI_PROVIDER`, `MOM_AI_MODEL`
3. Default: `anthropic` / `claude-sonnet-4-5`

### 5.3 API key resolution

Uses existing `ModelRegistry.getApiKey(model)` which already supports:
- `AuthStorage` per-provider credentials
- Environment variable fallback (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
- Custom provider configs from `models.json`

---

## Execution Order

| Step | Description | Risk | Dependencies |
|------|-------------|------|--------------|
| 1 | Define `ChatAdapter`, `ChatMessage`, `ChatResponseContext` interfaces | Low | None |
| 2 | Extract platform-agnostic system prompt builder | Low | Step 1 |
| 3 | Replace hardcoded model/provider with config | Low | None |
| 4 | Add `thread_ts` to SlackEvent, derive session key | Medium | Step 1 |
| 5 | Change directory structure for per-thread sessions | Medium | Step 4 |
| 6 | Move per-channel runner/queue to per-session | Medium | Step 4-5 |
| 7 | Restructure files into `adapters/slack/` | Medium | Step 1-2 |
| 8 | Change `AgentRunner.run()` signature | High | Step 1-7 |
| 9 | Wire everything together in `main.ts` | High | All above |
| 10 | Test: single thread, multi-thread concurrent, DM, events | High | All above |

---

## Out of Scope (for this PR)

- Discord adapter implementation (future, separate PR)
- QEMU sandbox replacement (separate issue)
- BlockKit rich formatting (separate enhancement)
- Clawdis-style concurrent DM handling (future)

---

## Breaking Changes

- `context.jsonl` location moves from `{channelId}/context.jsonl` to `{channelId}/sessions/{rootTs}/context.jsonl`
- Migration: existing `context.jsonl` can be treated as a "channel-scope" session (backward compatible if `sessionScope: "channel"`)
- `settings.json` gets new fields (additive, non-breaking)
