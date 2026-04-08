# MCP Server Reference

Documentation for preprocessing variants and MCP tools intended for external agent consumption.

---

## Preprocessing-Only Agent Variants

Each search agent has a preprocessing-only variant that performs all data gathering and context building, then returns a structured result — stopping before the LLM response generation. These power the MCP tools and can also be called internally to DRY up agent logic.

### `preprocessPdfContext(message, paperIds)`

**File**: `src/lib/search/pdfContext/agent.ts`

Fetches paper metadata and sections (`main_text`, `figure_captions`) from the database, reconstructs combined text with paper headers and figure caption sections, and builds source metadata.

- **Inputs**: `message` (string), `paperIds` (number[])
- **Returns**: `PdfContextPreprocessResult` — `{ message, reconstructedText, sources }`
- **LLM required**: No
- **Used by**: `PdfContextAgent.execute()` (internal), `queryPdfContext` MCP tool (planned)

### `preprocessWebSearch(query, history, llm)`

**File**: `src/lib/search/webSearch/agent.ts`

Classifies the query (via LLM), runs SearXNG web search with general engines in parallel, deduplicates by URL, and caps results at 10.

- **Inputs**: `query` (string), `history` (Array<[string, string]>), `llm` (BaseChatModel)
- **Returns**: `WebSearchPreprocessResult` — `{ standaloneQuery, searchResults, sources }`
- **LLM required**: Yes (classifier step only — query reformulation, not response generation)
- **Used by**: `executeSearch()` in WebSearchAgent (internal), future MCP tool

### `preprocessAcademicSearch(query, history, llm)`

**File**: `src/lib/search/academicSearch/agent.ts`

Classifies the query (via LLM), runs SearXNG academic search (arxiv, google scholar, pubmed) in parallel, deduplicates by URL, caps at 45 results, and sorts by reputable publisher priority. Skips the LLM-as-judge filtering step — returns all deduplicated results for the external agent to judge relevance.

- **Inputs**: `query` (string), `history` (Array<[string, string]>), `llm` (BaseChatModel)
- **Returns**: `AcademicSearchPreprocessResult` — `{ standaloneQuery, filteredResults, sources }`
- **LLM required**: Yes (classifier step only — query reformulation, not response generation or filtering)
- **Used by**: `executeSearch()` in AcademicSearchAgent (internal), future MCP tool

### Design Decisions

- **No LLM filtering in academic preprocess**: The LLM-as-judge step is skipped in the MCP variant. The external agent is the LLM and should decide relevance itself. Results are still sorted by reputable publisher priority.
- **Shared code**: Each original agent delegates its data-fetching phase to the preprocessing function, avoiding duplication.
- **Structured returns**: All variants return plain objects (not EventEmitters) since streaming is not needed for MCP tool responses.

---

## MCP Server

**File**: `src/server/mcp/index.ts`
**Transport**: Streamable HTTP (port 3001 by default, configurable via `MCP_PORT`)
**Run**: `yarn mcp:server` (standalone) or `yarn dev` (starts MCP + Next.js together)

The MCP server exposes GoFetch's preprocessing and chat-write capabilities to external agents (e.g. GitHub Copilot, Claude Desktop). It uses `@modelcontextprotocol/sdk` with Streamable HTTP transport on `http://localhost:3001/mcp`.

### Tools

#### `queryPdfContext`

Runs the preprocessing portion of `PdfContextAgent` and returns structured context. No internal LLM call — the external agent reasons over the returned text itself.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | yes | The user/agent query |
| `paperIds` | number[] | yes | IDs of papers to use as context |

**Returns** (JSON in text content):
- `message` — the original query, passed through
- `reconstructedText` — full paper context with headers, ready for an LLM prompt
- `sources` — array of `{ pageContent, metadata: { title, paperId } }`

Delegates to `preprocessPdfContext()` from `src/lib/search/pdfContext/agent.ts`.

#### `submitChatResponse`

Writes an externally-crafted assistant response into a GoFetch chat session so it appears in the UI on next load.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chatId` | string | yes | Target chat session ID |
| `responseText` | string | yes | The assistant message content to display |
| `sources` | array | no | Source documents (`{ pageContent, metadata }`) to attach |
| `createIfMissing` | boolean | no | If true, creates the chat when `chatId` doesn't exist (default: false) |

**Returns** (JSON in text content):
- `success` — boolean
- `chatId` — echoed back
- `messageId` — ID of the inserted assistant message

Inserts a `role: "assistant"` row (and optionally a `role: "source"` row) into the `messages` table. The `ChatProvider` picks these up via `loadMessages()` → `getChat(chatId)` on next navigation.

### Configuration

**GitHub Copilot** — registered automatically by `yarn dev`, or manually:

```bash
gh copilot mcp add --name gofetch --url http://localhost:3001/mcp
```

**Claude Desktop / Claude Code** — add to the MCP config (uses the HTTP endpoint):

```json
{
  "mcpServers": {
    "gofetch": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### Startup

`yarn dev` runs a platform-specific script (`scripts/dev.sh` on macOS/Linux, `scripts/dev.cmd` on Windows) that:

1. Checks `gh auth status` and runs `gh auth login` if needed
2. Registers the MCP server with GitHub Copilot (`gh copilot mcp add`)
3. Starts Next.js (port 3000) and the MCP server (port 3001) concurrently

To start the MCP server standalone: `yarn mcp:server`

### Copilot Bridge Integration

When the frontend sends `chatModel.providerId: "copilot"` in the chat request, the `/api/chat` route bypasses the model registry and spawns the Copilot CLI headlessly via `src/lib/copilot/bridge.ts`. The MCP server runs alongside, so Copilot can call `queryPdfContext` / `submitChatResponse` autonomously if instructed.

See `copilot/` section in [FEATURES.md](FEATURES.md) for full details.
