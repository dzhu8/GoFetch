# Chat Feature Reference

End-to-end map of every file involved in the chat feature, from page routes through React components, API handlers, agent pipelines, prompt templates, database schema, and MCP server tools.

---

## 1. Page Routes

### `/c` -- [src/app/c/page.tsx](src/app/c/page.tsx)

Re-exports `ChatWindow`. Renders a new (empty) chat session.

### `/c/[chatId]` -- [src/app/c/[chatId]/page.tsx](src/app/c/[chatId]/page.tsx)

Re-exports `ChatWindow`. Renders an existing chat by ID (loaded via `ChatProvider`).

### `/chats` -- [src/app/chats/page.tsx](src/app/chats/page.tsx)

Chat history page. Fetches all chats via `getChats()` server action, displays them as a list with title, date, and delete button. Delete uses `deleteChat()` with a confirmation modal. Clicking a chat navigates to `/c/{chatId}`.

---

## 2. API Routes

### `POST /api/chat` -- [src/app/api/chat/route.ts](src/app/api/chat/route.ts)

Central chat endpoint. Accepts a JSON body validated by Zod:

| Field | Type | Description |
|-------|------|-------------|
| `message` | `{ messageId, chatId, content }` | User message payload |
| `focusMode` | `string` (default `"code"`) | Agent selection key |
| `history` | `[role, content][]` | Conversation history tuples |
| `files` | `string[]` | Attached file IDs (legacy) |
| `attachedPaperIds` | `number[]` | Paper IDs for PDF context agent |
| `chatModel` | `{ providerId, key }` | Selected LLM model |
| `systemInstructions` | `string \| null` | Custom system prompt |

**Routing logic:**

1. **Copilot path** (`providerId === "copilot"`): Bypasses model registry, delegates to `handleCopilotChat()` from `src/lib/copilot/bridge.ts`. For web/academic focus modes, runs SearXNG preprocessing to inject real search results into the Copilot prompt. For code/generic modes, spawns Copilot directly with a markdown formatting instruction (no SearXNG needed).
2. **PDF context path** (`attachedPaperIds` present): Lazy-loads `PdfContextAgent`, calls `searchAndAnswer()` with paper IDs.
3. **Default path**: Loads LLM from provider registry, selects search agent via `getSearchAgent(focusMode)` (web search by default), calls `searchAndAnswer()`.

**Streaming protocol** (`handleEmitterEvents`): Listens on the agent's `EventEmitter` and writes newline-delimited JSON to a `TransformStream`. Event types:

| Agent event | Client JSON type | Action |
|-------------|-----------------|--------|
| `response` | `message` | Appends to `receivedMessage`, forwards chunk |
| `sources` | `sources` | Forwards source documents, persists `SourceMessage` to DB. For academic search, sources are deferred until after generation completes and are pruned to only those actually cited in the response. |
| `status` | `status` | Forwards search progress indicator |
| `error` | `error` | Forwards error message |
| `end` | `messageEnd` | Closes stream, persists `AssistantMessage` to DB |

**History persistence** (`handleHistorySave`): Runs concurrently with streaming. Creates the `chats` row on first message (title = message content, or paper titles if content is empty). On rewrites, deletes all messages after the rewrite point.

### `POST /api/academic-search` -- [src/app/api/academic-search/route.ts](src/app/api/academic-search/route.ts)

Academic search endpoint. Same streaming protocol as `/api/chat` but accepts `query` instead of `content`, has no file support, and routes directly to the academic search agent. When `providerId === "copilot"`, delegates to `handleCopilotChat()` with `focusMode: "academic"`.

### `GET /api/searxng/health` -- [src/app/api/searxng/health/route.ts](src/app/api/searxng/health/route.ts)

Lightweight SearXNG availability check (3-second timeout). Returns `{ available: true }` (200) or `{ available: false, error }` (503). Called by the chat context before navigation when web or academic search is needed, so users see the error before leaving the home page.

### `POST /api/suggestions`

Generates follow-up suggestions. Accepts `{ chatHistory, chatModel }`, returns `{ suggestions: string[] }`. Called client-side by `getSuggestions()`.

---

## 3. React Components

### Core Chat Components

#### [ChatWindow.tsx](src/components/ChatWindow.tsx)

Top-level chat container. Consumes `useChat()` to read `hasError`, `isReady`, `notFound`, `messages`, `relatedPapers`. Renders:
- Error state: connection failure message + settings button.
- Loading state: spinner via `<Loader />`.
- Ready + no messages: `<EmptyChat />`.
- Ready + messages: `<Chat />`.

Also defines and exports all message type interfaces used throughout the chat system:

| Type | Fields |
|------|--------|
| `BaseMessage` | `chatId`, `messageId`, `createdAt` |
| `AssistantMessage` | `role: "assistant"`, `content`, `suggestions?` |
| `UserMessage` | `role: "user"`, `content` |
| `SourceMessage` | `role: "source"`, `sources: Document[]` |
| `SuggestionMessage` | `role: "suggestion"`, `suggestions: string[]` |
| `SearchStatus` | `stage`, `message`, `details?` |
| `Message` | Union of the four message types |
| `ChatTurn` | `UserMessage \| AssistantMessage` |

#### [Chat.tsx](src/components/Chat.tsx)

Main chat renderer. Maps `sections` from `useChat()` into `<MessageBox>` components separated by dividers. Shows `<SearchStatusIndicator>` and `<MessageBoxLoading>` during generation. Renders `<RelatedPapersPanel>` entries below messages. Pins `<MessageInput>` to the bottom. Auto-scrolls on new messages when the user is near the bottom.

#### [EmptyChat.tsx](src/components/EmptyChat.tsx)

Landing page for new chats. Centers the `<EmptyChatMessageInput>` with a heading and settings button.

#### [EmptyChatMessageInput.tsx](src/components/EmptyChatMessageInput.tsx)

Initial message input with a richer toolbar than the in-conversation `MessageInput`. Includes `<ModelSelector>`, `<ChatToolDropdown>`, `<PdfSelector>`, and an academic mode badge (removable chip showing when `focusMode === "academic"`). Auto-focuses on mount. `/` keyboard shortcut focuses the textarea.

### Message Display Components

#### [MessageBox.tsx](src/components/MessageBox.tsx)

Renders one conversation section (user question + AI response). Displays:
- User message as a large heading.
- Source documents via `<MessageSources>`.
- AI response via `markdown-to-jsx` with custom overrides for `<think>` (ThinkBox), `<citation>` (Citation), `<mathblock>` (MathDisplay), `<mathinline>` (MathInline). Math content is preprocessed via `preprocessMath()` to base64-encode LaTeX before markdown parsing.
- Action buttons: `<Rewrite>` and `<Copy>`.
- Follow-up suggestions as clickable buttons (last section only, when not loading).

#### [MessageInput.tsx](src/components/MessageInput.tsx)

In-conversation message input. Auto-resizing textarea (`react-textarea-autosize`). Switches between single-line (rounded pill with inline tools) and multi-line (rounded card with tools below) layouts based on content height. Tools: `<ChatToolDropdown>`, `<PdfSelector>`. Enter submits, Shift+Enter for newline. `/` keyboard shortcut focuses when no input is active. Send button disabled when message is empty and no papers attached.

#### [MessageBoxLoading.tsx](src/components/MessageBoxLoading.tsx)

Skeleton loading placeholder (three animated bars) shown while waiting for the first response chunk.

#### [MessageSources.tsx](src/components/MessageSources.tsx)

Grid of source cards. Shows first 3 sources inline with title, favicon (or PDF icon for local sources), and source number. If >3 sources, a 4th card opens a modal dialog listing all sources. Uses `@headlessui/react` Dialog.

#### [SearchStatusIndicator.tsx](src/components/SearchStatusIndicator.tsx)

Animated status banner shown during search pipeline stages. Maps each stage to an icon and color:

| Stage | Icon | Color |
|-------|------|-------|
| `analyzing` | Search | blue |
| `searching` | Database | purple |
| `embedding` | Cpu | orange |
| `retrieving` | FileCode | green |
| `generating` | Sparkles | pink |

Uses `framer-motion` for enter/exit/pulse animations.

#### [ThinkBox.tsx](src/components/ThinkBox.tsx)

Collapsible panel for `<think>` blocks from extended-reasoning models. Auto-expands while thinking is in progress, auto-collapses when `thinkingEnded` becomes true. Toggle button with brain icon.

#### [Citation.tsx](src/components/Citation.tsx)

Inline citation link rendered as a small styled `<a>` tag. Receives `href` (source URL) and children (citation number). Opens in new tab.

#### [MathBlock.tsx](src/components/MathBlock.tsx)

LaTeX rendering via KaTeX. Exports `MathDisplay` (block `$$...$$`), `MathInline` (inline `$...$`), and `preprocessMath()` which converts LaTeX delimiters to `<mathblock>`/`<mathinline>` HTML tags with base64-encoded content to prevent markdown parser interference. Registered as `markdown-to-jsx` overrides in MessageBox.

#### [RelatedPapersPanel.tsx](src/components/RelatedPapersPanel.tsx)

Displays results from the Snowball Graph algorithm. Header shows seed paper title (linked via DOI or OpenAlex), candidate/citation counts. Scrollable list of `PaperCard` components with rank, domain badge, academic badge, BC/CC score badges, linked title, author/year/venue metadata, and abstract snippet. Close button removes the panel via `removeRelatedPapers()`.

### Message Action Components (`src/components/messageActions/`)

#### [ChatModelSelector.tsx](src/components/messageActions/ChatModelSelector.tsx)

Popover dropdown for switching the active chat model. Fetches providers via `getProviders()` server action. Groups models by provider with the current provider listed first. Searchable. Selecting a model calls `setChatModelProvider()` and persists via `persistModelPreference("chat", ...)`. Also shows OCR models in a separate section if available, with persist via `persistModelPreference("ocr", ...)`.

#### [ChatToolDropdown.tsx](src/components/messageActions/ChatToolDropdown.tsx)

Popover menu accessed via `+` button. Contains:
- **Parse PDF**: Overlay wrapping `<ParsePDF>` (file input triggers on click).
- **Related Papers**: Overlay wrapping `<GetRelatedPapers>`.
- **Search Modes section**: Toggle button for Academic Web Search (`focusMode` toggle between `"academic"` and `"default"`).

#### [ParsePDF.tsx](src/components/messageActions/ParsePDF.tsx)

Multi-step PDF upload flow:
1. **Folder picker modal**: Lists library folders, with option to create a new one via `createLibraryFolder()`.
2. **File picker**: Hidden `<input type="file" accept=".pdf">`.
3. **Confirmation modal**: Warns about processing time, offers "Start & Background" button.

Delegates actual upload work to `PdfParseProvider.startParseJob()`.

#### [GetRelatedPapers.tsx](src/components/messageActions/GetRelatedPapers.tsx)

Multi-path related papers flow:
1. **Method picker modal**: Choose between DOI entry or PDF upload.
2. **DOI path**: Input field -> `resolvePaperByDoiAction()` -> confirmation card showing S2 ID and cache status -> `buildRelatedPapersGraphAction()`.
3. **PDF path**: Folder picker -> file picker -> OCR extraction via `/api/related-papers/paddleocr/extract` (streamed NDJSON with page progress) -> `extractDocumentMetadata()` for title/DOI -> `buildRelatedPapersGraphAction()`.

Results are added to chat via `addRelatedPapers()` and rendered by `<RelatedPapersPanel>`.

#### [PdfSelector.tsx](src/components/messageActions/PdfSelector.tsx)

Paperclip popover for attaching processed PDFs as context. Lazy-fetches `status = "ready"` papers via `listReadyPapers()`. Toggle-based selection stored as `attachedPaperIds` in chat context. Badge shows count when papers are attached. "Clear all" footer.

#### [CopyMessage.tsx](src/components/messageActions/CopyMessage.tsx)

Copies assistant message content + citation URLs to clipboard. Shows checkmark for 1 second after copy.

#### [RewriteMessage.tsx](src/components/messageActions/RewriteMessage.tsx)

"Rewrite" button that calls `rewrite(messageId)` from chat context to regenerate a response from a specific point in the conversation.

#### [AttachMobile.tsx](src/components/messageActions/AttachMobile.tsx)

Mobile-optimized file attachment. Uploads files to `/api/uploads` with embedding model info. Popover shows attached files with add/clear actions. Accepts `.pdf`, `.docx`, `.txt`.

---

## 4. Chat State Management

### [src/lib/chat/Chat.tsx](src/lib/chat/Chat.tsx)

React context provider managing all conversation state. Documented extensively in [FEATURES.md section 1](FEATURES.md). Key exports:

- **`ChatProvider`**: Wraps the app, supplies all chat state and functions.
- **`useChat()` hook**: Returns the full `ChatContext`.
- **`Section` type**: Groups one user message with its parsed assistant response, sources, thinking state, suggestions, and speech text.

Core functions: `sendMessage()`, `sendAcademicSearch()`, `rewrite()`, `checkConfig()`, `loadMessages()`.

The `sections` memo handles citation linking, `<think>` tag completion, and math preprocessing.

---

## 5. Server Actions

### [src/lib/actions/chats.ts](src/lib/actions/chats.ts)

| Function | Description |
|----------|-------------|
| `getChats()` | Returns all chats in reverse chronological order |
| `getChat(id)` | Returns a single chat with all its messages, or `{ error }` on 404 |
| `deleteChat(id)` | Deletes the chat and all associated messages |

All are `"use server"` actions using Drizzle ORM against the `chats` and `messages` tables.

---

## 6. Database Schema (Chat Tables)

Defined in [src/server/db/schema.ts](src/server/db/schema.ts):

### `messages` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer | PK, auto-increment |
| `role` | text enum | `"assistant"`, `"user"`, `"source"` |
| `chatId` | text | FK to chats.id (no cascade -- deleted manually) |
| `createdAt` | text | Default `CURRENT_TIMESTAMP` |
| `messageId` | text | Client-generated hex ID |
| `content` | text | Message body (null for source messages) |
| `sources` | JSON text | `Document[]` (default `[]`) |

### `chats` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | text | PK, client-generated |
| `title` | text | First message content or paper titles |
| `createdAt` | text | Timestamp string |
| `files` | JSON text | `FileDetails[]` (default `[]`) |

---

## 7. Agent Pipeline

### Agent Selection

The chat route selects agents in this priority:

1. `providerId === "copilot"` -> `handleCopilotChat()` (bridge.ts)
2. `attachedPaperIds` present -> `PdfContextAgent`
3. Otherwise -> `getSearchAgent(focusMode)` from [src/lib/search/index.ts](src/lib/search/index.ts), which returns `WebSearchAgent` for all modes.

### Agent Implementations

All agents extend `BaseSearchAgent` ([src/lib/search/baseSearchAgent.ts](src/lib/search/baseSearchAgent.ts)) and return an `EventEmitter` with the standard event protocol (`data` -> `end`/`error`). Documented in [FEATURES.md section 11](FEATURES.md).

| Agent | File | Focus Mode |
|-------|------|------------|
| `WebSearchAgent` | [src/lib/search/webSearch/agent.ts](src/lib/search/webSearch/agent.ts) | `"default"`, `"code"` |
| `AcademicSearchAgent` | [src/lib/search/academicSearch/agent.ts](src/lib/search/academicSearch/agent.ts) | `"academic"` (via separate route) |
| `PdfContextAgent` | [src/lib/search/pdfContext/agent.ts](src/lib/search/pdfContext/agent.ts) | When `attachedPaperIds` present |

### Copilot Bridge

[src/lib/copilot/bridge.ts](src/lib/copilot/bridge.ts) -- Documented in [FEATURES.md section 12](FEATURES.md). `handleCopilotChat()` preprocesses based on focus mode (PDF: `preprocessPdfContext()`; web/academic: `preprocessWebSearch()` / `preprocessAcademicSearch()` without an LLM, falling back to raw queries for SearXNG; code/generic: no preprocessing, just a markdown formatting instruction), builds a grounded prompt from the existing prompt templates, and spawns a headless Copilot CLI. For academic mode, the full response is buffered and sources are deferred — after Copilot finishes, sources are pruned to only those cited and citations are remapped before emitting sources + response together. For web mode, sources are emitted immediately and the response streams. If SearXNG is unavailable for web/academic modes, emits an error and stops.

---

## 8. Prompt Templates

### [src/lib/prompts/webSearch.ts](src/lib/prompts/webSearch.ts)

- **`webClassifierPrompt`**: Instructs the LLM to reformulate a user query into a standalone question + up to 3 targeted web search queries. Output: JSON with `standaloneQuery` and `searchQueries[]`.
- **`getWebWriterPrompt(context, systemInstructions)`**: Synthesis prompt. Requires inline citations `[1]`, `[2]`, no bibliography, markdown formatting. Wraps answer in `<output>` tags. Injects current UTC date and optional user instructions.

### [src/lib/prompts/academicSearch.ts](src/lib/prompts/academicSearch.ts)

Documented in [FEATURES.md section 9](FEATURES.md). Three exports: `academicClassifierPrompt`, `academicFilterPrompt`, `getAcademicWriterPrompt()`.

### [src/lib/prompts/pdfContext.ts](src/lib/prompts/pdfContext.ts)

- **`getPdfOrganizerPrompt(reconstructedText)`**: Instructs the LLM to reorganize paper text into per-figure subsections. Text-processing only (no summarization, no Q&A). Output wrapped in `<output>` tags.
- **`getTestPdfOrganizerPrompt(reconstructedText)`**: Variant that extracts only Figure 1 for validation.

---

## 9. Utilities

### [src/lib/utils/formatHistory.ts](src/lib/utils/formatHistory.ts)

`formatChatHistoryAsString(history: BaseMessage[])` -- Converts LangChain `BaseMessage[]` to a single string with `"AI: ..."` / `"User: ..."` lines. Used by classifiers to format conversation context.

### [src/lib/output/suggestions/actions.ts](src/lib/output/suggestions/actions.ts)

`getSuggestions(chatHistory, chatModel)` -- POSTs to `/api/suggestions`, returns `string[]`. Called by `ChatProvider` after `messageEnd` when sources exist and no suggestions have been generated yet.

### [src/lib/models/modelPreference.ts](src/lib/models/modelPreference.ts)

`persistModelPreference(kind, preference)` -- POSTs to `/api/config` to save the user's chat/embedding/OCR model selection.

---

## 10. MCP Server Tools

[src/server/mcp/index.ts](src/server/mcp/index.ts) exposes two tools relevant to chat:

### `queryPdfContext`

Preprocesses PDF context without an LLM call. Accepts `{ message, paperIds }`, returns reconstructed paper text and source metadata. Intended for external agents to do their own reasoning.

### `submitChatResponse`

Writes an externally-crafted assistant response into a GoFetch chat. Accepts `{ chatId, responseText, sources?, createIfMissing? }`. Persists the message to the DB so it appears in the UI.

---

## Data Flow Summary

```
User types message
  |
  v
EmptyChatMessageInput / MessageInput
  |
  v
ChatProvider.sendMessage()
  |-- sets loading state, creates UserMessage
  |-- POST /api/chat (with chatModel, history, focusMode, attachedPaperIds)
  |
  v
/api/chat route.ts
  |-- validates body (Zod)
  |-- selects agent: Copilot | PdfContext | WebSearch
  |-- creates TransformStream for SSE response
  |-- handleEmitterEvents: listens on agent EventEmitter
  |     |-- "status" -> forwards to client
  |     |-- "sources" -> forwards + persists SourceMessage
  |     |-- "response" -> forwards as "message" chunk
  |     |-- "end" -> sends "messageEnd" + persists AssistantMessage
  |-- handleHistorySave: creates chat row (first message) + UserMessage row
  |
  v
ChatProvider reads stream chunks
  |-- "status" -> updates searchStatus (SearchStatusIndicator)
  |-- "sources" -> adds SourceMessage (MessageSources)
  |-- "message" -> appends to AssistantMessage (MessageBox)
  |-- "messageEnd" -> resets loading, updates history,
  |     triggers getSuggestions() if sources exist
  |
  v
sections memo recomputes
  |-- groups messages into Section[]
  |-- links citations to source URLs
  |-- completes <think> tags
  |-- preprocesses math
  |
  v
Chat.tsx re-renders MessageBox components
```
