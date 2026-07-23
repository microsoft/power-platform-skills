---
name: add-workiq
description: Adds Work IQ (M365 Copilot Search) to a Power Apps code app via the Work IQ Copilot MCP connector (shared_a365copilotchatmcp), then wires up a production-ready McpSession wrapper for AI-powered, knowledge-grounded search and chat. Use when integrating Microsoft 365 Copilot search/chat. The CopilotChat tool searches internal Microsoft 365 content (documents, emails, chats, sites, files) across your organization — prefer workload-specific tools (SharePoint, OneDrive, Teams, Mail) when the workload is explicit; do not use it for general knowledge, news, public web, or external information.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Work IQ (M365 Copilot Search)

Work IQ is accessed through the dedicated **Work IQ Copilot MCP** connector (`shared_a365copilotchatmcp`; shown as "Work IQ Copilot MCP (Preview)" in the maker portal). It exposes an MCP (Model Context Protocol) endpoint whose `CopilotChat` tool performs AI-powered, knowledge-grounded search and conversation over Microsoft 365 content.

> This is the purpose-built Work IQ connector and generates a `WorkIQCopilotMCPService` with a single `mcp_m365copilot` operation. **Every command and code reference in this skill is specific to `shared_a365copilotchatmcp`** (connection commands, and the generated `WorkIQCopilotMCPService` / `WorkIQCopilotMCPModel` files). Do not run this skill for a different connector. If you instead need the broader `shared_a365mcpservers` "Microsoft 365 MCP Servers" bundle (Mail/Teams/SharePoint MCP servers), add it via `/add-connector` — its generated service is `MicrosoftMCPServersService`, so you must adjust the Step 2 commands and the wrapper imports accordingly.

> ⚠️ **Work IQ uses MCP.** A JSON-RPC `initialize` handshake runs before the first `tools/call`. This connector's server (`Microsoft.MCPPlatform.WebApi`) is **stateless-tolerant** — do **NOT** send an `Mcp-Session-Id` on `initialize` (the server treats it as a session lookup and returns `-32001 Session not found`). Drive the connector through the `McpSession` wrapper below, which runs the handshake, sends **no** session id by default, sequences JSON-RPC ids, auto-retries on `Session not found`, and parses the nested response for you.

## Workflow

1. Check Memory Bank → 2. Add Connector → 3. Inspect Generated Service → 4. Create McpSession Wrapper → 5. Use Work IQ → 6. Build → 7. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Add Connector

The Power Apps code-app CLI (`@microsoft/power-apps-cli`, invoked as `npx power-apps`) creates the connection and generates the typed service itself. Make sure the CLI is installed (`npm install`) and you are signed in (`npx power-apps auth-status`; it shares the same auth as the rest of the code-app skills).

#### Find or Create the Connection

**Check for an existing connection first:**

```bash
npx power-apps list-connections --search "a365copilotchatmcp"
```

If a **Work IQ Copilot MCP (Preview)** connection is listed, note its Connection ID and skip to "Add the Data Source" below.

**Otherwise create one** with the native `create-connection` verb:

```bash
npx power-apps create-connection --api-id shared_a365copilotchatmcp
```

- The environment is read automatically from the app's `power.config.json` — you do **not** need to pass an environment id.
- This connector requires OAuth, so the CLI **opens a browser to complete sign-in/consent** (SSO-only connectors complete silently with no browser).
- On success it prints the **Connection ID** — save it for the next step.

**STOP HERE — interactive sign-in required:**

1. Tell the user the browser has opened (or share the URL the CLI prints).
2. Ask them to sign in with their Microsoft 365 account and grant consent to the **Work IQ Copilot MCP** connector.
3. **Wait for the user to confirm** the browser shows success before continuing.

**If `create-connection` fails:**
- "not signed in" / auth error → run `npx power-apps auth-status` (sign in if needed) and retry.
- "Connection creation was cancelled." → the browser flow was closed early; re-run and complete it.
- Any other non-zero exit → report the exact error and STOP.

As a fallback, the user can create the connection manually in the maker portal: `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for "Work IQ Copilot MCP" → Create, then re-run `list-connections`.

#### Add the Data Source

Once the connection exists, add it to the code app (this is what generates the typed service + model):

```bash
npx power-apps add-data-source -a shared_a365copilotchatmcp -c <connection-id>
```

This is a **non-tabular** connector — only `-a` (api id) and `-c` (connection id) are needed.

### Step 3: Inspect Generated Service

After adding the connector, confirm the generated service is present. This is a small, single-operation service, so you can read it directly or grep it:

```
Grep pattern="async \w+" path="src/generated/services/WorkIQCopilotMCPService.ts"
```

The `WorkIQCopilotMCPService` exposes exactly one operation — **`mcp_m365copilot`** ("Work IQ Copilot (Preview)"), plus a `Getmcp_m365copilot` GET variant used only for connection verification. Work IQ / CopilotChat is driven through **`mcp_m365copilot`**.

Its generated signature is:

```typescript
public static async mcp_m365copilot(
  Mcp_Session_Id?: string,
  queryRequest?: QueryRequest
): Promise<IOperationResult<void>>
```

- First argument is the **MCP session id** (the connector's `Mcp-Session-Id` parameter). Leave it **`undefined`** — this server assigns/needs no client session id, and sending one on `initialize` returns `-32001` (see below).
- Second argument is the JSON-RPC body, typed as `QueryRequest` (`{ jsonrpc?, id?, method?, params?, result?, error? }`) — exported from `src/generated/models/WorkIQCopilotMCPModel.ts`.
- Return type is `IOperationResult<void>`; the actual JSON-RPC / SSE body arrives in `result.data` at runtime.

**Facts you can rely on (do not try to discover them at runtime):**

- The tool name is **`CopilotChat`** (case-sensitive). Do not substitute `query`, `search`, or `find`.
- The argument key is **`message`** — not `query`, `prompt`, or `question`.
- **Do NOT send an `Mcp-Session-Id` on the `initialize` handshake.** This connector's server treats an incoming id as an existing-session lookup and returns `-32001 Session not found`. The server is **stateless-tolerant**: `initialize` and `tools/call` both succeed with **no** session id, so the `McpSession` wrapper below tracks none by default.

> **Session-id handling (verified during testing).** This connector's MCP server is **stateless-tolerant**. `initialize` with **no** `Mcp-Session-Id` returns `200` with server capabilities, and a subsequent `tools/call` with **no** id returns the Copilot reply — no session id needs to be tracked or echoed. Do **not** generate a client id and send it on `initialize`: the server treats it as a lookup and returns `404 / -32001 Session not found` (this was a real bug in an earlier version of this wrapper). Note that the code-apps data layer's `IOperationResult<TResponse>` exposes only `{ success, data, error, skipToken, count, fileName }` — it does **not** surface response headers — so if a future MCP server returns a session id only in the `Mcp-Session-Id` **response header**, it would be unreadable here. The wrapper still defensively adopts a server id if one ever appears inside `result.data`.

### Step 4: Create McpSession Wrapper

⚠️ **CRITICAL:** MCP session handling and response parsing are intricate. Copy the production-ready `McpSession` class below **exactly**. It runs the `initialize` handshake (sending **no** session id), sequences JSON-RPC ids, auto-retries on "Session not found", persists the conversation id, and parses the deeply nested response.

Create `src/connectors/mcpClient.ts`:

```typescript
// src/connectors/mcpClient.ts
import type { IOperationResult } from '@microsoft/power-apps/data'
import { WorkIQCopilotMCPService } from '../generated/services/WorkIQCopilotMCPService'
import type { QueryRequest } from '../generated/models/WorkIQCopilotMCPModel'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc?: string
  id?: string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string; data?: unknown }
}

type CopilotConversationMessage = {
  text?: string
  attributions?: Array<{
    attributionType?: string
    providerDisplayName?: string
    seeMoreWebUrl?: string
  }>
}

type CopilotConversation = {
  messages?: CopilotConversationMessage[]
}

function parseRpc(result: IOperationResult<unknown>): JsonRpcResponse {
  if (!result.success && result.error) {
    return { error: { message: result.error.message } }
  }

  const data: unknown = result.data
  if (data == null) return {}
  if (typeof data === 'object') return data as JsonRpcResponse
  if (typeof data === 'string') {
    // Handle SSE framing: "event: message\ndata: {JSON}"
    const dataLines = data
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    const payload = dataLines.length ? dataLines.join('') : data
    try {
      return JSON.parse(payload) as JsonRpcResponse
    } catch {
      return { result: { raw: data } }
    }
  }

  return { result: { raw: data } }
}

export class McpSession {
  private nextId = 1
  // MCP Streamable HTTP: the client must NOT send a session id on `initialize` —
  // the server assigns one. Sending a client-generated id makes this connector's
  // server return `404 / -32001 Session not found`. This server is stateless-
  // tolerant, so we send no id at all; `extractSessionId` still adopts a server
  // id if one ever surfaces in the response body.
  private sessionId: string | undefined = undefined
  private conversationId: string | undefined
  private initialized = false

  private extractSessionId(raw: IOperationResult<unknown>): string | undefined {
    const container = raw as unknown as Record<string, unknown>
    const dataObj =
      raw.data && typeof raw.data === 'object'
        ? (raw.data as Record<string, unknown>)
        : undefined
    const resultObj =
      dataObj?.result && typeof dataObj.result === 'object'
        ? (dataObj.result as Record<string, unknown>)
        : undefined

    const candidates: Array<unknown> = [
      dataObj?.['Mcp-Session-Id'],
      dataObj?.mcpSessionId,
      dataObj?.sessionId,
      resultObj?.['Mcp-Session-Id'],
      resultObj?.mcpSessionId,
      resultObj?.sessionId,
      container['Mcp-Session-Id'],
      container.mcpSessionId,
      container.sessionId,
    ]

    const found = candidates.find((value) => typeof value === 'string' && value.length > 0)
    return typeof found === 'string' ? found : undefined
  }

  private isSessionNotFound(res: JsonRpcResponse): boolean {
    const message = (res.error?.message ?? '').toLowerCase()
    return message.includes('session not found') || res.error?.code === -32001
  }

  private resetSession(): void {
    // Drop any session id and re-handshake from scratch (no id on `initialize`).
    this.sessionId = undefined
    this.initialized = false
  }

  private async send(
    method: string,
    params?: Record<string, unknown>,
    allowRetry = true
  ): Promise<JsonRpcResponse> {
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: String(this.nextId++), method, params }

    // Send the current session id only if we have one (undefined on the initial
    // handshake and for this stateless-tolerant server).
    const raw = (await WorkIQCopilotMCPService.mcp_m365copilot(
      this.sessionId,
      req as unknown as QueryRequest
    )) as unknown as IOperationResult<unknown>

    const negotiatedSessionId = this.extractSessionId(raw)
    if (negotiatedSessionId) {
      this.sessionId = negotiatedSessionId
    }

    const parsed = parseRpc(raw)

    if (allowRetry && method !== 'initialize' && this.isSessionNotFound(parsed)) {
      this.resetSession()
      await this.initialize()
      return this.send(method, params, false)
    }

    return parsed
  }

  async initialize(): Promise<JsonRpcResponse> {
    const res = await this.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'Power Apps Code App', version: '1.0.0' },
    })
    this.initialized = !res.error
    return res
  }

  /** Discover the available MCP tools (optional; the tool name is fixed as `CopilotChat`). */
  async listTools(): Promise<JsonRpcResponse> {
    if (!this.initialized) await this.initialize()
    return this.send('tools/list', {})
  }

  async callCopilotChat(message: string): Promise<{ text: string; conversationId?: string }> {
    if (!this.initialized) await this.initialize()
    const raw = await this.send('tools/call', {
      name: 'CopilotChat',
      arguments: {
        message,
        ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      },
    })

    const parsed = extractCopilotText(raw)
    if (parsed.conversationId) {
      this.conversationId = parsed.conversationId
    }

    return { text: parsed.text, conversationId: parsed.conversationId }
  }
}

function extractContentText(res: JsonRpcResponse): string | undefined {
  const content = res.result?.content as Array<{ type?: string; text?: string }> | undefined
  if (!Array.isArray(content)) {
    return undefined
  }

  const textBlocks = content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!.trim())
    .filter((value) => value.length > 0)

  if (textBlocks.length === 0) {
    return undefined
  }

  // Prefer the JSON payload block. Some responses append metadata text blocks
  // such as "CorrelationId: ..." that should not be concatenated.
  const jsonBlock = textBlocks.find(
    (block) => block.startsWith('{') && /"conversationId"|"rawResponse"|"reply"/.test(block)
  )
  if (jsonBlock) {
    return jsonBlock
  }

  const nonMetadata = textBlocks.find((block) => !/^CorrelationId\s*:/i.test(block))
  return nonMetadata ?? textBlocks[0]
}

export function extractCopilotText(res: JsonRpcResponse): {
  text: string
  conversationId?: string
} {
  if (res.error) {
    return { text: `Error: ${res.error.message ?? JSON.stringify(res.error)}` }
  }

  const rawText = extractContentText(res)
  if (!rawText) {
    return { text: res.result ? JSON.stringify(res.result, null, 2) : '(no content returned)' }
  }

  try {
    const inner = JSON.parse(rawText) as {
      conversationId?: string
      reply?: string
      message?: string
      rawResponse?: string
    }

    if (typeof inner.rawResponse === 'string') {
      try {
        const convo = JSON.parse(inner.rawResponse) as CopilotConversation
        const messages = Array.isArray(convo.messages) ? convo.messages : []
        // messages[0] echoes the user query; the AI reply is the one carrying
        // attributions (citations). Fall back to index 1, then the last message.
        const attributed = messages.find(
          (m) => Array.isArray(m.attributions) && m.attributions.length > 0
        )
        const selected = attributed ?? messages[1] ?? messages[messages.length - 1]
        const replyText = selected?.text?.trim()
        if (replyText) {
          return { text: replyText, conversationId: inner.conversationId }
        }
      } catch {
        // Fall through to simple reply extraction.
      }
    }

    const fallbackText = inner.reply?.trim() || inner.message?.trim() || rawText
    return { text: fallbackText, conversationId: inner.conversationId }
  } catch {
    return { text: rawText }
  }
}
```

> **Session-id note (verified during testing).** `McpSession` starts with **no** session id and sends none on the `initialize` handshake. Testing against `shared_a365copilotchatmcp` (server `Microsoft.MCPPlatform.WebApi`) confirmed it is **stateless-tolerant**: `initialize` with no id returns `200` + capabilities, and `tools/call` with no id returns the Copilot reply. Sending a client-generated id on `initialize` instead makes the server return `404 / -32001 Session not found` — that was the original bug. `IOperationResult` exposes only `{ success, data, error, skipToken, count, fileName }` (no response headers), so a header-only session id would be unreadable here; `extractSessionId` still adopts a server id if one ever appears inside `result.data`, and the handshake auto-retries on `Session not found` for resilience.
>
> If you ever bind a *different* MCP connector that is genuinely stateful and returns its session id only in the `Mcp-Session-Id` response header, this SDK cannot read it — capture one raw `mcp_m365copilot` result in the debugger to confirm where the id surfaces, and if it appears inside `result.data`, add that path to `extractSessionId`.

### Step 5: Use Work IQ

Initialize **once per app** (e.g., in a React `useEffect` on boot or a module singleton) and reuse for all Work IQ calls:

```typescript
import { McpSession } from './connectors/mcpClient'

// Initialize once per app session and reuse across calls.
const workIqSession = new McpSession()

export async function queryWorkIQ(userPrompt: string): Promise<string> {
  try {
    const { text } = await workIqSession.callCopilotChat(userPrompt)
    if (text.startsWith('Error:')) {
      throw new Error(text)
    }
    return text
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Work IQ query failed'
    console.error('Work IQ Error:', msg)
    throw error
  }
}
```

**Key patterns:**

- ✅ Initialize once, reuse across multiple calls (never `new McpSession()` per request)
- ✅ Pass context-specific prompts to `callCopilotChat()`
- ✅ The session auto-reinitializes if a "Session not found" error occurs
- ✅ `conversationId` is automatically persisted across calls for multi-turn chats

#### Prompt Structure

Work IQ responds well to **context-rich, structured prompts**. Adapt this pattern for your scenario:

```typescript
const prompt = `
You are [role/expert description].

**Context:**
- [Relevant data or background information]
- [Additional context as needed]

**Task:** [Clear, specific instruction]

**Format:**
- Use markdown with clear section headings (## Summary, ## Action Items, etc.)
- Specify limits (word count, number of items, etc.)
`.trim()

const { text } = await workIqSession.callCopilotChat(prompt)
```

Adaptable scenarios: meeting summaries with action items, prioritized daily action items from email, project risk analysis from documents, team performance insights, or any knowledge-grounded analysis over M365 data.

#### Response Parsing

`callCopilotChat()` already unwraps the nested JSON-RPC / SSE response and returns clean `text`. Parse that text according to the format you requested.

**For structured markdown output** (when you asked for `## sections`):

```typescript
function extractSection(text: string, sectionName: string): string[] {
  const regex = new RegExp(`##\\s*${sectionName}\\s*([\\s\\S]*?)(?=##|$)`)
  const match = text.match(regex)
  if (!match) return []

  return match[1]
    .split('\n')
    .filter((line) => line.trim().startsWith('-'))
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean)
}

const { text } = await workIqSession.callCopilotChat(prompt)
const summary = extractSection(text, 'Summary')
const actionItems = extractSection(text, 'Action Items')
```

**For unstructured output** — use `text` directly (display as-is or format for your UI).

#### Why the McpSession Pattern Is Required

Work IQ uses **MCP (Model Context Protocol)**. Driving it correctly requires:

1. **Session initialization** before the first call (handshake to exchange capabilities)
2. **Session handling** — this connector is **stateless-tolerant**, so the wrapper sends **no** session id (sending one on `initialize` triggers `-32001 Session not found`); it defensively adopts a server id only if one ever surfaces in the response body (see the session-id note above)
3. **JSON-RPC id sequencing** (each request needs a unique incrementing id)
4. **Multi-turn conversation support** via conversation-id persistence
5. **Nested response parsing** (JSON-RPC → text content → inner JSON → Graph conversation)
6. **Automatic recovery** on session timeouts (`-32001` / "Session not found")

`McpSession` handles all of this. Bypassing it (ad-hoc per-call ids or direct calls without the handshake) leads to "Session not found" errors and failed integrations.

### Step 6: Build

```bash
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 7: Update Memory Bank

Update `memory-bank.md` with: connector added (`shared_a365copilotchatmcp`), McpSession wrapper created at `src/connectors/mcpClient.ts`, Work IQ usage wired up, build status.

**IMPORTANT — Do NOT save sensitive information:**

- ❌ OAuth URLs or consent links
- ❌ Connection IDs
- ❌ Session IDs or tokens
- ❌ Environment IDs
- ❌ Any authentication credentials

Only save high-level progress like "Work IQ Copilot MCP connector configured" or "Work IQ CopilotChat integration implemented via McpSession".
