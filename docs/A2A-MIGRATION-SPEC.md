# A2A Migration Spec — NanoClaw Inter-Agent Communication

**Status**: Draft — awaiting Taj review
**Authors**: Mai (mainion-ai), Taj (taj)
**Date**: 2026-04-11

## 1. Problem Statement

The current agent-mailbox system has these limitations:
- No agent discovery (hardcoded IPs/ports)
- No structured task delegation (free-text messages only)
- No capability advertisement
- Fragile: the auth header bug took hours to diagnose
- Custom protocol with no ecosystem support

## 2. Target Architecture

Replace agent-mailbox with A2A (Agent2Agent Protocol, v0.3.0) using `@a2a-js/sdk`.

### Topology: Peer-to-Peer

Each NanoClaw instance runs its own A2A server. No shared hub.

```
┌──────────────────┐         ┌──────────────────┐
│  Beelink (.19)   │         │  Pi (.24)        │
│                  │  HTTP   │                  │
│  NanoClaw        │◄───────►│  NanoClaw        │
│  A2A Server :4100│         │  A2A Server :4100│
│  Agent: mainion  │         │  Agent: taj      │
└──────────────────┘         └──────────────────┘
         │                            │
         └────────┬───────────────────┘
                  │ Telegram
                  ▼
           Nenad (observer)
```

### Why Not Shared Hub

- Single point of failure (the exact bug we just fixed)
- Peer-to-peer matches the A2A protocol design
- Each agent owns its own Agent Card and capabilities
- Simpler network: each agent only needs to reach the other

## 3. Agent Card — Dynamic Generation

Agent Cards are NOT static JSON files. They are generated at request time from NanoClaw runtime state.

```typescript
// GET /.well-known/agent.json
function generateAgentCard(): AgentCard {
  return {
    protocolVersion: '0.3.0',
    name: ASSISTANT_NAME,
    description: `NanoClaw agent: ${group.description || 'personal assistant'}`,
    url: `http://${HOST}:${A2A_PORT}`,
    provider: {
      organization: 'NanoClaw',
      url: 'https://github.com/anthropics/nanoclaw',
    },
    version: NANOCLAW_VERSION,
    capabilities: {
      streaming: true,
      pushNotifications: true,  // for Nenad observer hook
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    // Generated from installed skills + MCP tools
    skills: getInstalledSkills().map(s => ({
      id: s.name,
      name: s.name,
      description: s.description,
      tags: s.tags || [],
    })),
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    security: [{ bearerAuth: [] }],
  };
}
```

### Discovery

On startup, each agent fetches the other's Agent Card:
```
GET http://192.168.1.24:4100/.well-known/agent.json  # Taj
GET http://192.168.1.19:4100/.well-known/agent.json  # Mai
```

Agent addresses are configured in `.env`:
```env
A2A_PORT=4100
A2A_PEERS=http://192.168.1.24:4100,http://192.168.1.19:4100
A2A_AUTH_TOKEN=<shared-secret>
```

Future: mDNS/DNS-SD for automatic discovery on LAN.

## 4. Task Lifecycle

### Sending a Task (Client Side)

```typescript
import { A2AClient } from '@a2a-js/sdk';

const client = new A2AClient('http://192.168.1.24:4100');

// Simple message
const response = await client.sendMessage({
  message: {
    role: 'user',
    kind: 'message',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text: 'Update memory-kernel to v1.10.0' }],
  },
  configuration: {
    // Register Nenad's observer webhook
    pushNotification: {
      url: `http://192.168.1.19:4100/observer-hook`,
      token: OBSERVER_TOKEN,
    },
  },
});
```

### Receiving a Task (Server Side — AgentExecutor)

```typescript
class NanoClawExecutor implements AgentExecutor {
  async execute(context: RequestContext, eventBus: IExecutionEventBus): Promise<void> {
    const userText = context.userMessage.parts
      .filter(p => p.kind === 'text')
      .map(p => p.text)
      .join('\n');

    // Update status to working
    await eventBus.publish({
      kind: 'status-update',
      taskId: context.task.id,
      contextId: context.task.contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    });

    // Inject as synthetic message into NanoClaw's message loop
    // (same pattern as current mailbox notification injection)
    injectA2AMessage(userText, context.task.id);

    // Wait for agent session to complete and collect result
    const result = await waitForAgentResult(context.task.id);

    // Publish result
    await eventBus.publish({
      kind: 'artifact-update',
      taskId: context.task.id,
      contextId: context.task.contextId,
      artifact: {
        artifactId: crypto.randomUUID(),
        name: 'Agent Response',
        parts: [{ kind: 'text', text: result }],
      },
      lastChunk: true,
    });

    await eventBus.publish({
      kind: 'status-update',
      taskId: context.task.id,
      contextId: context.task.contextId,
      status: { state: 'completed', timestamp: new Date().toISOString() },
      final: true,
    });

    eventBus.finished();
  }

  async cancelTask(taskId: string): Promise<void> {
    cancelAgentSession(taskId);
  }
}
```

## 5. Observer Hook for Nenad

Replaces the current mailbox CC mechanism. Nenad gets task events via Telegram.

### Implementation

The A2A server exposes a webhook endpoint that receives push notifications:

```typescript
// On the sending agent's A2A server
app.post('/observer-hook', (req, res) => {
  const event = req.body;
  // Forward to Nenad via Telegram
  const summary = formatTaskEventForTelegram(event);
  telegramBot.sendMessage(NENAD_CHAT_ID, summary);
  res.sendStatus(200);
});
```

When agent A sends a task to agent B, it registers the observer webhook:
```typescript
configuration: {
  pushNotification: {
    url: 'http://192.168.1.19:4100/observer-hook',
    token: OBSERVER_TOKEN,
  },
}
```

Agent B's A2A server POSTs status updates and artifacts to this webhook.

### What Nenad Sees

```
🔄 [Taj → Mai] Task started: "Review A2A migration spec"
✅ [Taj → Mai] Task completed: "Spec approved with 2 changes"
❌ [Mai → Taj] Task failed: "SSH connection refused"
```

## 6. MCP Tool Replacement

### Current MCP Tools (agent-mailbox)

| Tool | Purpose |
|------|---------|
| `send_message` | Send free-text message |
| `check_inbox` | Read unread messages |
| `mark_read` | Mark messages as read |
| `list_agents` | List registered agents |

### New MCP Tools (A2A)

| Tool | Purpose |
|------|---------|
| `a2a_send_task` | Send structured task to peer agent |
| `a2a_send_message` | Send simple message (maps to `message/send`) |
| `a2a_get_task` | Check task status and result |
| `a2a_list_peers` | List discovered peer agents (from Agent Cards) |
| `a2a_cancel_task` | Cancel a running task |

### MCP Server Implementation

The A2A MCP server is a stdio process (same spawn model as current mailbox MCP client):

```typescript
// container/agent-runner spawns:
{
  a2a_client: {
    command: 'node',
    args: [
      A2A_MCP_CLI_PATH,
      'connect',
      '--peers', A2A_PEERS,       // comma-separated peer URLs
      '--auth-token', A2A_AUTH_TOKEN,
    ],
  },
}
```

## 7. Authentication

Simple shared Bearer token (same as current mailbox). Both agents use the same token.

```env
A2A_AUTH_TOKEN=<shared-secret>
```

The A2A server validates `Authorization: Bearer <token>` on all requests.
Agent Cards declare this via `securitySchemes.bearerAuth`.

Future: per-agent tokens, mTLS for production.

## 8. Migration Phases

### Phase 1: A2A Servers Alongside Mailbox

**Goal**: Both A2A servers running, Agent Cards served, one real task exchange.

**Deliverables**:
1. `src/a2a-server.ts` — A2A Express server with dynamic Agent Card
2. `src/a2a-executor.ts` — NanoClawExecutor that injects messages into NanoClaw
3. A2A server starts as part of NanoClaw startup (or as a separate systemd service)
4. Agent Cards accessible at `/.well-known/agent.json` on both machines
5. Test: Mai sends a task to Taj via A2A, Taj processes and returns result
6. Mailbox continues to work in parallel (no disruption)

**Config additions to `.env`**:
```env
A2A_PORT=4100
A2A_PEERS=http://192.168.1.24:4100
A2A_AUTH_TOKEN=<token>
```

**Estimated effort**: 1-2 sessions per agent.

### Phase 2: MCP Tool Switchover

**Goal**: Agent sessions use A2A tools instead of mailbox tools.

**Deliverables**:
1. `a2a-mcp-server.ts` — MCP stdio server exposing A2A tools
2. Update `agent-runner/src/index.ts` to spawn A2A MCP instead of mailbox MCP
3. Update NanoClaw polling to check A2A task status instead of mailbox unread
4. Observer hook wired to Nenad's Telegram
5. Test: full round-trip task exchange using only A2A tools
6. Mailbox still running but unused

### Phase 3: Mailbox Removal

**Goal**: Clean removal of mailbox, A2A as sole transport.

**Deliverables**:
1. Remove mailbox MCP server from agent-runner
2. Remove mailbox polling from `index.ts`
3. Remove `MAILBOX_*` env vars
4. Stop and disable `agent-mailbox.service`
5. Update docs

## 9. File Structure

```
src/
  a2a-server.ts          # A2A Express server setup
  a2a-executor.ts        # NanoClawExecutor (task -> message injection)
  a2a-observer.ts        # Observer webhook -> Telegram forwarding
  a2a-config.ts          # A2A config from .env
container/
  a2a-mcp-server/        # MCP stdio server for agent sessions
    src/
      index.ts           # CLI entry point
      tools.ts           # MCP tool definitions
    package.json
    tsconfig.json
```

## 10. Dependencies

```json
{
  "@a2a-js/sdk": "^0.3.10",
  "express": "^4.21.0"
}
```

Both machines already have Node 22 and npm.

## 11. Open Questions

1. **Task persistence**: Use `InMemoryTaskStore` (simplest) or SQLite (survives restart)?
   - Recommendation: SQLite, reuse existing NanoClaw DB module.

2. **Port choice**: 4100 is arbitrary. Any conflicts?
   - Mailbox is on 3847. Telegram bot doesn't bind a port. 4100 should be clear.

3. **Streaming vs polling**: Use SSE streaming for real-time task updates, or poll `tasks/get`?
   - Recommendation: Start with `message/send` (synchronous). Add streaming in Phase 2.

4. **Multi-turn tasks**: Support `input-required` state for tasks that need clarification?
   - Recommendation: Not in Phase 1. Add in Phase 2 if needed.

5. **npm publish for memory-kernel v1.10.0**: Still pending. Independent of A2A work.
