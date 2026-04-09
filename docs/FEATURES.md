# GoFetch `src/lib` Module Reference

Detailed descriptions of every subfolder (and standalone files) under `src/lib/`, covering routes, middleware, function chains, callbacks, data flow, and the "how & why" behind each component.

---

## 1. `chat/`

Contains a single file: [Chat.tsx](src/lib/chat/Chat.tsx).

### Purpose

Manages all conversation state, message handling, model configuration, and API communication.

### Exported Constructs

- **`Section` type** -- Groups one user message with its corresponding assistant response, parsed content, speech-ready text, source documents, thinking state, and follow-up suggestions.
- **`chatContext`** -- React context object (`createContext<ChatContext>`) carrying all chat state and functions.
- **`ChatProvider`** -- React provider component wrapping the entire app to supply chat state.
- **`useChat` hook** -- Context consumer returning the full `ChatContext`.

### Key Internal Functions

#### `checkConfig()` (Bootstrap)

Runs once on mount. Fetches `/api/config` and `/api/providers` in parallel, validates configuration, then calls `resolveModelPreference()` (from `../models/preferenceResolver`) for chat, embedding, and OCR models. On error: shows toast, sets `hasError = true`.

#### `loadMessages()` (Chat Restore)

Fetches `/api/chats/{chatId}`. On 404, marks `notFound = true`. Otherwise extracts messages, filters into chat turns (user + assistant only), maps turns to `[role, content]` tuples for history, sets document title to first message, maps file data, and sets `isMessagesLoaded = true`.

#### `sendMessage()` (Core Message Pipeline)

The primary message-sending function. Flow:

1. **Guard** -- If academic mode, delegates to `sendAcademicSearch()`. Returns early if loading or message empty.
2. **SearXNG pre-check** -- When no papers are attached (web search path), calls `GET /api/searxng/health` before navigation. If SearXNG is unavailable, shows a `toast.error` and returns early — the user stays on the current page.
3. **State init** -- Sets `loading = true`, `messageAppeared = false`. On first message, updates URL to `/c/{chatId}`.
3. **User message** -- Immediately adds a `UserMessage` to local state.
4. **POST `/api/chat`** -- Sends message content, chatId, fileIds, chat history (optionally sliced for rewrites), chatModel `{key, providerId}`, embeddingModel `{key, providerId}`, and systemInstructions.
5. **Stream response** -- Reads `response.body` chunk-by-chunk via `TextDecoder`, parses newline-delimited JSON. Each message has a `type` field:
   - `"error"` -- Toast notification, reset loading/searchStatus, return.
   - `"status"` -- Updates `searchStatus` for UI progress indicators (analyzing, searching, embedding, retrieving, generating).
   - `"sources"` -- Clears searchStatus, marks `messageAppeared = true`, adds `SourceMessage` containing retrieved documents.
   - `"message"` -- First chunk creates a new `AssistantMessage`; subsequent chunks append to it. Content is tracked in a `recievedMessage` variable.
   - `"messageEnd"` -- Finalizes: updates `chatHistory` with `[human, message]` + `[assistant, recievedMessage]`, resets loading/searchStatus. Then checks if suggestions are needed: finds the user message index, the source message, and the suggestion message index. If sources exist AND no suggestions yet, calls `getSuggestions()` (from `../output/suggestions/actions`) and adds a `SuggestionMessage`.

#### `sendAcademicSearch()` (Academic Mode)

Nearly identical to `sendMessage()` but POSTs to `/api/academic-search` with `query` instead of `content`, has no file support, no auto-suggestions logic, and does not update history until `messageEnd`. Includes the same SearXNG pre-check — always required since academic search depends on SearXNG.

#### `rewrite()` (Response Regeneration)

Finds the message by ID, locates the previous user message, slices messages and chatHistory to that point, then calls `sendMessage()` with `rewrite = true`. This allows regeneration from any point in the conversation.

### `sections` Memoized Computation

The most complex computation in Chat.tsx. Groups `messages` into `Section[]` where each section = 1 user message + associated response. Per section:

1. Find AI response and source message after user message.
2. Detect and complete unclosed `<think>` tags; track `thinkingEnded` flag.
3. **Citation linking** -- If sources exist, regex `\[([^\]]+)\]` matches `[anything]`, splits comma-separated numbers (e.g. `[1,2,3]`), maps number N to `sources[N-1]`, and creates `<citation href="...">N</citation>` links using `metadata.url`. If no sources, strip citation numbers.
4. Create `speechMessage` (stripped of citation numbers for TTS).
5. Attach suggestions if present.

### React Hook Lifecycle

| Effect | Trigger | Action |
|--------|---------|--------|
| Config load | Mount (once) | `checkConfig()` |
| Home page reset | `pathname === "/"` | Clears ALL state for new chat |
| Chat ID change | `params.chatId` | Resets state, triggers `loadMessages()` |
| Message loading | `chatId` + not loaded | `loadMessages()` from DB; or generates random chatId |
| Messages ref sync | `messages` changes | Keeps `messagesRef.current` current to avoid stale closures |
| Ready state | Config + messages loaded | Sets `isReady = true` (prevents rendering before ready) |
| Initial message | `?q=` query param + ready | Auto-sends the query parameter as first message |

### API Endpoints Called

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/config` | GET | Load user configuration |
| `/api/providers` | GET | Get available model providers |
| `/api/chats/{chatId}` | GET | Load chat history from DB |
| `/api/chat` | POST | Send message, stream response (status/sources/message/messageEnd/error) |
| `/api/academic-search` | POST | Academic-focused search (same streaming format) |
| `/api/suggestions` | POST | Generate follow-up suggestions |
| `/api/searxng/health` | GET | Pre-send SearXNG availability check (3s timeout) |

### Dependencies

- `@/components/ChatWindow` -- Message types (`AssistantMessage`, `ChatTurn`, `Message`, `SourceMessage`, `SuggestionMessage`, `UserMessage`, `SearchStatus`, `RelatedPapersResponse`)
- `@/lib/output/suggestions/actions` -- `getSuggestions()`
- `@/lib/models/preferenceResolver` -- `resolveModelPreference()`, `resolveOcrModelPreference()`
- `@/lib/models/types` -- `MinimalProvider`

---

## 2. `chunk/`

Files: [index.ts](src/lib/chunk/index.ts), [types.ts](src/lib/chunk/types.ts), [chunker.ts](src/lib/chunk/chunker.ts), [fileWalker.ts](src/lib/chunk/fileWalker.ts), [formats.ts](src/lib/chunk/formats.ts).

### Purpose

Breaks down text files into manageable pieces for semantic embedding and search. Handles file discovery, format detection, and intelligent text chunking with context-aware boundaries.

### Types (`types.ts`)

- **`SupportedTextFormat`** -- `"markdown" | "text" | "json" | "yaml" | "toml" | "xml" | "csv" | "ini" | "log" | "env"`
- **`TextChunk`** -- A single chunk with `index`, `startIndex`/`endIndex` (char offsets), `startPosition`/`endPosition` (row/col as `SerializedPosition`), `content`, `tokenCount` (~4 chars/token estimate), and `truncated` flag.
- **`ChunkedFile`** -- Result for one file: `filePath`, `relativePath`, `format`, `chunks: TextChunk[]`, `totalChunks`, `totalCharacters`.
- **`ChunkerOptions`** -- `maxTokens?` (default 1000), `overlapTokens?` (default 100), `preferNaturalBoundaries?` (default true).
- **`FileEntry`** -- `absolutePath` + `relativePath`.
- **`FolderRegistrationLike`** -- `name`, `rootPath`, `tree: FolderTreeNode`.

### Format Detection (`formats.ts`)

`detectTextFormat(filePath)` checks `FORMAT_BY_EXTENSION` map first (`.md`/`.mdx`/`.markdown` -> markdown, `.txt`/`.text` -> text, `.json`/`.jsonc`/`.json5` -> json, `.yaml`/`.yml` -> yaml, `.toml` -> toml, `.xml`/`.xhtml`/`.svg` -> xml, `.csv`/`.tsv` -> csv, `.ini`/`.cfg`/`.conf` -> ini, `.env`/`.env.*` -> env, `.log` -> log), then `KNOWN_TEXT_FILES` by basename (e.g. `readme` -> markdown, `license`/`makefile`/`dockerfile` -> text, `.prettierrc` -> json, `.editorconfig` -> ini). Returns `null` if unknown.

Also exports `isSupportedTextFile()`, `getSupportedExtensions()`, `getKnownTextFileNames()`.

### File Discovery (`fileWalker.ts`)

`listSupportedTextFiles(registration)` calls `walkDirectory()` recursively. For each entry:
- Skips symbolic links.
- Skips directories in `IGNORED_DIRECTORY_NAMES` (from `@/server/folderIgnore`): `node_modules`, `.git`, `.next`, `dist`, `build`, `coverage`, `__pycache__`, `.turbo`, `.vercel`, `.cache`.
- Skips files in `IGNORED_FILE_NAMES`: `.DS_Store`, `Thumbs.db`.
- For remaining files, checks `isSupportedTextFile()` and adds to results.

### Core Chunking Engine (`chunker.ts`)

**`chunkFile(entry, options?)`** -- Detects format, reads file safely (`safeRead` with try-catch around `fs.readFileSync`), normalizes options via `normalizeOptions()` (reads from `configManager.getConfig()` for `preferences.textChunkMaxTokens` and `preferences.textChunkOverlapTokens`), then calls `splitIntoChunks()`. Returns `ChunkedFile` or `null` on failure.

**`chunkFiles(entries, options?)`** -- Batch version; filters out nulls.

**`chunkText(content, format, options?)`** -- Chunks raw text (no file path needed).

#### `splitIntoChunks()` Algorithm

1. Converts tokens to characters: `maxChars = maxTokens * 4`, `overlapChars = overlapTokens * 4`.
2. Creates `PositionLookup` (pre-computes newline positions for O(log N) binary-search line/column lookups).
3. **Main loop**: For each chunk starting at `currentStart`:
   - `targetEnd = min(currentStart + maxChars, content.length)`.
   - If not at EOF and `preferNaturalBoundaries`: calls `findNaturalBoundary()`.
   - Extracts slice, estimates tokens (`Math.ceil(length / 4)`), creates `TextChunk`.
   - Moves to next: `currentStart = max(currentStart + 1, targetEnd - overlapChars)`.
   - If `preferNaturalBoundaries`: adjusts via `adjustStartToWordBoundary()`.

#### `findNaturalBoundary()` Priority

Looks back up to 20% of chunk size for:
1. **Paragraph break** (`\n\n`) -- highest priority.
2. **Sentence end** (`.`, `!`, `?` followed by whitespace).
3. **Line break** (`\n`).
4. **Word boundary** (space).
5. **Exact target** -- fallback.

#### `adjustStartToWordBoundary()`

Ensures next chunk doesn't start mid-word. Searches forward up to 50 chars for a space or newline.

### Public Entry Point (`index.ts`)

**`chunkFolderRegistration(registration, options?)`** -- Calls `listSupportedTextFiles()` then `chunkFiles()`. This is the main entry point for folder-level text chunking.

Re-exports all types and functions from submodules.

### Dependencies

- `@/server` (configManager) -- Runtime chunk size configuration.
- `@/server/folderIgnore` -- `IGNORED_DIRECTORY_NAMES`, `IGNORED_FILE_NAMES`.
- Node.js `fs`, `path` -- File system access.
- No external NPM dependencies.

---

## 3. `citations/`

Contains a single file: [parseReferences.ts](src/lib/citations/parseReferences.ts) (~579 lines).

### Purpose

Processes OCR output from PDF documents to extract and parse bibliographic reference information. Converts raw OCR data into structured citation metadata with provenance tracking, DOI extraction, and title heuristics.

### Exported Types

- **`SourceBlock`** -- Tracks where a reference fragment came from: `pageIndex`, `blockId`, `blockOrder`, `segmentIndex`.
- **`ParsedReference`** -- Final structured output: `refNum` (1-based), `index` (0-based), `text` (stitched reference), `searchTerm` (DOI or extracted title), `isDoi`, `rawFragments[]`, `sourceBlocks[]`.
- **`DocumentMetadata`** -- `title: string | null`, `doi: string | null`.

### `parseReferences(ocrResult)` -- Main Pipeline

Orchestrates 8 steps:

1. **`collectRawBlocks()`** -- Extracts blocks with label `reference_content` or `reference` from OCR JSON. Normalizes content, collects bounding box coordinates. Sorts by: pageIndex -> blockOrder -> bboxY0 -> bboxX0. Uses `extractParsingResList()` to recursively search for `parsing_res_list` arrays (handles alternate keys: `res`, `result`, `parsing_result`, `blocks`, `children`).

2. **`normalizeText()`** -- Trims, collapses whitespace, normalizes line endings (`\r\n` -> `\n`), removes space-before-newline and newline-before-space artifacts.

3. **Reference Starter Detection** -- `STARTER_RE`: `/^\s*([^0-9]{0,2}?)(\d{1,4})\.\s*([\s\S]*)$/` matches optional noise (0-2 chars) + 1-4 digits + period. `matchStarter()` returns `{refNum, rest}`. `isCitationLine()` identifies `Citation: ...` metadata lines to skip.

4. **`splitMultiEntryBlock()`** -- If a single OCR block contains 2+ starters, splits at boundaries into `Segment[]` with `segmentIndex`. Prepends orphan lines before first starter to the first segment.

5. **`joinChunk(current, chunk)`** -- Intelligent fragment joining:
   - **De-hyphenate**: `"word-" + "continuation"` -> `"wordcontinuation"`.
   - **URL/DOI continuation**: No space if current ends with `https://`, `doi:`, or `10.####`.
   - **Default**: Space between.

6. **`stitchSegments()`** -- State machine grouping segments into `EntryAccumulator[]`. When a starter line is found, creates a new entry. Non-starter segments join the current entry via `joinChunk()`. Orphans (before first starter) are collected in `pendingOrphans[]` and prepended to next entry; final orphans attach to last entry.

7. **DOI Extraction (`extractDoi()`)** -- 4 patterns tried:
   - Canonical `https://doi.org/10.####/...`.
   - Non-doi.org HTTPS URLs with embedded `doi.org/` or `/doi/` path.
   - `DOI: 10.####/...` label format.
   - Bare `10.xxxx` pattern not inside a URL.
   Trailing punctuation cleaned via `cleanDoi()`. URL spans tracked to prevent double-counting.

8. **Title Extraction (`extractTitle()`)** -- 6 heuristics in priority order:
   - Quoted text (`"..."`, 10-300 chars).
   - APA style: `(YYYY). Title.`.
   - Journal prefix: text before journal token (e.g. "Nature 421, ...").
   - Author list skip: skip author block, take next sentence.
   - Period-split fallback: middle sections between periods.
   - Last resort: first 150 characters.

**Output filtering**: Only returns references where `searchTerm.length > 3`.

### `extractDocumentMetadata(ocrResult)`

Checks first 3 pages for explicit `doc_title` label blocks and DOI. Returns `{title, doi}` or null values.

### Usage in Codebase

- `/src/app/api/papers/upload/route.ts` -- Extracts metadata for duplicate checking. Also cleans up existing `"error"` papers with the same filename in the same folder before inserting a new record, so re-uploads replace broken entries.
- `/src/app/api/papers/[id]/related-papers/route.ts` -- Title/DOI for Semantic Scholar lookup.
- `/src/app/api/cli/library/route.ts` and `/src/app/api/cli/related-papers/route.ts` -- Library and related-papers operations.
- `/src/components/messageActions/GetRelatedPapers.tsx` -- Client-side title/DOI extraction from uploaded PDF.

### Dependencies

Pure TypeScript with **no imports**. Operates on standard JS built-ins and `any`-typed OCR input for format flexibility.

---

## 4. `config/`

Contains a single file: [types.ts](src/lib/config/types.ts).

### Purpose

Defines all TypeScript types for the UI configuration system. The actual configuration management logic lives in `ConfigManager` (singleton in `/src/server/index.ts`); this module provides the type contracts.

### Type Hierarchy

```
UIConfigSections (root schema)
 +-- preferences: UIConfigField[]
 +-- personalization: UIConfigField[]
 +-- modelProviders: ModelProviderUISection[]
 |    +-- fields: UIConfigField[]
 +-- folders?: FolderUISection[]
 |    +-- fields: UIConfigField[]
 +-- search?: UIConfigField[]

UIConfigField (discriminated union)
 +-- StringUIConfigField  (type: "string", placeholder?, default?)
 +-- SelectUIConfigField  (type: "select", options: {name,value}[], default?)
 +-- TextareaUIConfigField (type: "textarea", placeholder?, default?)
 +-- SwitchUIConfigField  (type: "switch", default?)
 +-- NumberUIConfigField  (type: "number", placeholder?, default?, min?, max?, step?)

BaseUIConfigField (all extend this)
 +-- name, key, required, description
 +-- scope: "client" | "server"
 +-- env?: string (optional environment variable name)

Config (runtime data)
 +-- version: number
 +-- setupComplete: boolean
 +-- preferences: Record<string, any>
 +-- personalization: Record<string, any>
 +-- modelProviders: ConfigModelProvider[]
 +-- folder?: { path?, [key]: any }
```

### Configuration Categories

**Preferences** (server + client): theme, embedSummaries, embeddingPointSize, hnswM/hnswEfConstruction/hnswEfSearch/hnswScoreThreshold (HNSW params), textChunkMaxTokens/textChunkOverlapTokens (chunking), defaultChatModel, defaultEmbeddingModel.

**Personalization**: graphConstructionMethod ("snowball"), graphRankMethod ("bibliographic"/"embedding"), snowballDepth/snowballMaxPapers/snowballBcThreshold/snowballCcThreshold/snowballEmbeddingThreshold (related papers), systemInstructions (textarea).

**Model Providers**: Ollama (baseURL, env: `OLLAMA_API_URL`), Anthropic (apiKey, env: `ANTHROPIC_API_KEY`), OpenAI (apiKey + optional baseUrl, env: `OPENAI_API_KEY`).

**Folders**: folderURI (env: `INITIAL_FOLDER`).

**Search**: searxngURL (env: `SEARXNG_API_URL`).

### ConfigManager Integration

The `ConfigManager` class (singleton at `/src/server/index.ts`) uses these types:
- **Dual persistence**: JSON file (`<DATA_DIR>/data/config.json`) + SQLite (`app_settings` table via Drizzle ORM).
- **5-second cache TTL** on disk reads to reduce I/O.
- **Environment override**: `initializeFromEnv()` loads `OLLAMA_API_URL`, `OLLAMA_URL`, `SEARXNG_API_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `INITIAL_FOLDER`.
- **Nested key access**: Dot notation like `"preferences.hnswM"`.
- **API endpoints**: `GET /api/config` (returns values + fields), `POST /api/config` (updates key/value), `POST /api/config/setup-complete`.

---

## 5. `embed/`

Files: [types.ts](src/lib/embed/types.ts), [progress.ts](src/lib/embed/progress.ts), [paperProcess.ts](src/lib/embed/paperProcess.ts).

### Purpose

Orchestrates embedding generation and management for source code snippets and research papers. Implements a two-phase pipeline (optional LLM summarization + mandatory vector embedding) with batch processing, cancellation support, and detailed progress tracking.

### Progress Tracking (`progress.ts`)

Uses `globalThis` with Symbols for singleton instances surviving Next.js HMR/Turbopack module reloading.

- **`taskProgressEmitter: EventEmitter`** -- Global event emitter for task updates.
- **`updateTaskProgress(folderName, patch)`** -- Updates progress and emits `"update"` event. Triggers `folderEvents.notifyChange()` when phase reaches `"completed"` or `"error"` (for SSE clients).
- **`TaskPhase`**: `"idle" | "parsing" | "summarizing" | "embedding" | "completed" | "error"`.

### Paper OCR Processing (`paperProcess.ts`)

#### `processPaperOCR(paperId, ocrPath)`

Reads OCR JSON, filters blocks by allowed labels (`paragraph_title`, `abstract`, `figure_title`, `table`, `display_formula`, `text`), chunks content into 1000-line segments, then filters uninformative chunks (< 100 chars, no alphanumeric, DOI strings, 13 boilerplate keywords like "competing interests"/"acknowledgements", publication dates, author/affiliation lists with superscripts). Persists chunks to `paperChunks` table.

#### `queuePaperEmbedding(paperId, folderName, paperName)`

Adds paper to a global embedding queue (maintained on `globalThis`). Increments folder's total paper count, updates progress to `"embedding"`, triggers `processEmbeddingQueue()`.

#### `embedPaperChunks(paperId, folderName, paperName)`

Fetches paper chunks from DB, resolves embedding model from settings/registry, embeds in batches of 10, stores vectors as `Float32Array` buffers. Updates progress message with chunk completion count.

**Queue processing** is serialized: `processEmbeddingQueue()` uses `isProcessingQueue` flag to prevent concurrent processing. On completion of all papers for a folder, emits `"completed"`.

### Orphaned Paper Detection (`actions/papers.ts`)

`triggerPendingEmbeddings()` detects orphaned papers — those stuck in `"uploading"` or `"processing"` status with no `.ocr.json` sidecar on disk and no active OCR child process (`activeProcs`). These are marked `"error"` immediately so the UI shows the error card with Retry/Delete options instead of an infinite spinner.

### Paper Deletion Cleanup (`actions/papers.ts`)

`deletePaper()` performs full cleanup: removes the PDF file, the extracted figure image, the `.ocr.json` OCR sidecar, all `paperChunks` rows, and the `papers` DB record. The figure serving route (`/api/papers/[id]/figure`) uses `Cache-Control: no-cache` to prevent browsers from serving stale cached figures when SQLite reuses a deleted paper's rowid for a newly uploaded paper.

### Dependencies

- `@/lib/chunk` -- `chunkFolderRegistration`, `ChunkedFile`, `SupportedTextFormat`.
- `@/server/db` + schema -- `embeddings`, `textChunkSnapshots`, `paperChunks`, `papers` tables.
- `@/server/providerRegistry` -- Load chat/embedding models.
- `@/server/configManager` -- Read preferences.
- `@/lib/models/preferenceResolver` -- Model selection logic.
- `@langchain/core` -- LLM interfaces, messages.
- Node.js `crypto` -- SHA256 hashing.

---

## 6. `models/`

Files: [types.ts](src/lib/models/types.ts), [modelPreference.ts](src/lib/models/modelPreference.ts), [ollamaClient.ts](src/lib/models/ollamaClient.ts), [preferenceResolver.ts](src/lib/models/preferenceResolver.ts), and `providers/` subfolder with [BaseModelProvider.ts](src/lib/models/providers/BaseModelProvider.ts), [OpenAIProvider.ts](src/lib/models/providers/OpenAIProvider.ts), [AnthropicProvider.ts](src/lib/models/providers/AnthropicProvider.ts), [OllamaProvider.ts](src/lib/models/providers/OllamaProvider.ts), [PaddleOCRProvider.ts](src/lib/models/providers/PaddleOCRProvider.ts), [CopilotProvider.ts](src/lib/models/providers/CopilotProvider.ts).

### Purpose

Multi-provider LLM/embedding/OCR abstraction layer. Defines the contract for model providers, implements concrete providers for OpenAI, Anthropic, Ollama, PaddleOCR, and GitHub Copilot, and provides preference resolution with fallback logic.

### Core Types (`types.ts`)

- **`Model`** -- `{ name, key }`.
- **`EmbeddingModelClient`** -- Interface with `embedDocuments(documents: string[]): Promise<number[][]>`.
- **`ConfigModelProvider`** -- Full provider config: `id`, `name`, `type`, `chatModels[]`, `embeddingModels[]`, `ocrModels[]`, `config: Record<string, any>`, `hash` (SHA256 for change detection).
- **`MinimalProvider`** -- Lightweight subset without `config`/`hash`.
- **`ModelWithProvider`** -- `{ key, providerId }`.
- **`ModelList`** -- `{ embedding: Model[], chat: Model[], ocr: Model[] }`.

### Client-Side Preference Persistence (`modelPreference.ts`)

**`persistModelPreference(kind, preference)`** -- POSTs to `/api/config` with key mapping: `chat` -> `"preferences.defaultChatModel"`, `embedding` -> `"preferences.defaultEmbeddingModel"`, `ocr` -> `"preferences.defaultOCRModel"`.

### Ollama Client (`ollamaClient.ts`)

**`listOllamaModels()`** -- Fetches `GET ${OLLAMA_BASE_URL}/api/tags` (default: `http://localhost:11434`). Returns `OllamaTag[]` with model `name`, `size`, `digest`, and optional `details` (family, parameter_size, quantization_level).

### Preference Resolver (`preferenceResolver.ts`)

**`resolveModelPreference(kind, providers, configuredPreference)`** -- Resolution chain:
1. Validate providers array not empty.
2. Find provider matching configured preference ID with models of specified kind.
3. Fallback to first provider with available models.
4. Find model matching configured key within selected provider.
5. Fallback to first available model.
Throws descriptive errors at multiple validation points.

**`resolveOcrModelPreference()`** -- Non-throwing variant returning `null` if no OCR models configured.

### Abstract Base (`BaseModelProvider.ts`)

**`BaseModelProvider<ChatModel, EmbeddingModel>`** -- Abstract class defining the provider contract:
- Abstract methods: `getAvailableChatModels()`, `getAvailableEmbeddingModels()`, `getAvailableOCRModels()`, `loadChatModel(modelKey)`, `loadEmbeddingModel(modelKey)`, `loadOCRModel(modelKey)`.
- Concrete: `getModelMetadata(modelKey)` (optional override), `getModelList()`, `assertModelConfigured(modelKey, models)` (validation).
- `ProviderModelMetadata` type: `key`, `displayName?`, `parameters?`, `sizeGB?`, `contextWindow?`, `description?`, `inputPricePerMToken?`, `outputPricePerMToken?`.

### OpenAI Provider (`OpenAIProvider.ts`)

Extends `BaseModelProvider<ChatOpenAI, OpenAIEmbeddings>` (from `@langchain/openai`).

**Default models**: gpt-5.2, gpt-5, gpt-5-mini, gpt-5-nano, gpt-4.1, gpt-4o, gpt-4o-mini (chat); text-embedding-3-small, text-embedding-3-large (embedding). Static metadata includes pricing and context window sizes (8K-400K).

**`loadChatModel(modelKey)`** -- Validates config, requires API key, constructs `ChatOpenAI` with temperature/maxTokens/baseUrl from provider config. **`loadEmbeddingModel(modelKey)`** -- Same validation, returns `OpenAIEmbeddings` instance. Supports custom endpoints (Groq, Together) via `baseUrl`.

**Async metadata population**: Constructor initiates background fetch from OpenAI's model list API. `getModelList()` merges defaults with user-registered models (deduplicates by key); for custom endpoints, only shows user-registered models.

### Anthropic Provider (`AnthropicProvider.ts`)

Extends `BaseModelProvider<ChatAnthropic, never>` (no embedding support).

**Default models**: claude-opus-4-6, claude-sonnet-4-6, claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-1, claude-opus-4, claude-sonnet-4, claude-haiku-4. All 200K context. Static pricing metadata included.

**`loadChatModel(modelKey)`** -- Returns `ChatAnthropic` with API key, temperature, maxTokens, baseUrl. Supports date-suffixed model IDs (e.g. `claude-sonnet-4-6-20260101`) via `resolveStaticMetadata()`. Background metadata fetch from Anthropic API with proper headers (`x-api-key`, `anthropic-version`).

### Ollama Provider (`OllamaProvider.ts`)

Extends `BaseModelProvider<ChatOllama, OllamaEmbeddings>` (from `@langchain/ollama`).

**Dynamic model discovery** from local Ollama server. Infers model families (Llama, Qwen, Gemma, Mistral, Phi, Granite, Other). Marks certain models as "recommended" (`qwen3-embedding:8b`, `gpt-oss:20b`, `gemma3:27b`).

**`loadChatModel`** -> `ChatOllama`, **`loadEmbeddingModel`** -> `OllamaEmbeddings`, **`loadOCRModel`** -> `ChatOllama` (vision model for OCR). All with baseUrl from config.

**`getModelList()` (override)** -- Queries the local Ollama server (`/api/tags`) and filters registered chat/embedding/OCR models against actually installed models. This ensures deleted or externally removed models are pruned from all downstream consumers (settings dropdowns, chat model selector, library search modal, etc.) on the next data fetch. Falls back to the base implementation if Ollama is unreachable.

**Model deletion** -- `deleteOllamaModel()` server action (in `actions/ollama.ts`) handles full model removal: calls Ollama `DELETE /api/delete`, then deregisters the model from the provider's `chatModels`/`embeddingModels`/`ocrModels` via `modelRegistry.updateProvider()`. This persists to disk config, so the model disappears from all dropdowns and preference resolution on next refresh. `resolveModelPreference()` auto-falls-back to the first remaining model if the deleted model was the active preference.

### PaddleOCR Provider (`PaddleOCRProvider.ts`)

OCR-only. Single curated model: `PaddleOCR-VL` (requires GPU/CUDA). `loadOCRModel()` returns lightweight `{ modelKey, providerType: "paddleocr" }` (signals configuration, doesn't instantiate native code). Chat and embedding methods throw.

### Copilot Provider (`CopilotProvider.ts`)

Extends `BaseModelProvider<never, never>` (chat-only, no embedding/OCR). Delegates to the Copilot CLI bridge (`src/lib/copilot/bridge.ts`) instead of a LangChain model.

**Default models**: Claude Sonnet 4.5, Claude Sonnet 4, GPT-4o, GPT-4.1, o3-mini. The actual list depends on the user's GitHub plan; overridable via provider config.

**`loadChatModel()`** -- Throws. Never called — the chat route detects `providerId === "copilot"` and delegates to `handleCopilotChat()` before reaching `loadChatModel()`.

**Auto-injection**: `ModelRegistry.injectCopilotProvider()` adds a Copilot provider with fixed id `"copilot"` on startup if one isn't already configured. No manual setup required — appears in the model dropdown immediately.

### Key Design Patterns

- **Async-safe metadata**: Background population; separate sync `getModelMetadata()` and async `getModelMetadataAsync()` methods.
- **Deduplication**: Model lists merge defaults with user-registered models without duplication.
- **Static fallbacks**: OpenAI/Anthropic maintain hardcoded model lists + pricing for offline operation.

---

## 7. `output/`

Contains: [suggestions/actions.ts](src/lib/output/suggestions/actions.ts).

### Purpose

Client-side utility for fetching AI-generated follow-up suggestions.

### `getSuggestions(chatHistory, chatModel)`

**Parameters**: `chatHistory: Message[]` (full message history), `chatModel: { providerId: string; key: string }`.

**Flow**:
1. **Validation**: If either `providerId` or `key` is falsy, returns `[]` immediately without API call.
2. **POST `/api/suggestions`**: Sends `{ chatHistory, chatModel }` as JSON.
3. **Parse response**: Casts as `{ suggestions: string[] }`.
4. **Return**: The `suggestions` array.

### Invocation Context (in `Chat.tsx`)

Called after `messageEnd` event when:
- Source documents exist for the response.
- No suggestion message already exists for this turn.
- Chat model is fully configured.

Result is added as a `SuggestionMessage` to the messages array, displayed to the user as clickable follow-up prompts.

---

## 8. `prompts/`

Contains: [academicSearch.ts](src/lib/prompts/academicSearch.ts).

### Purpose

System prompts for the academic research pipeline. Three exports drive query classification, result filtering, and response generation.

### `academicClassifierPrompt` (string constant)

Instructs the LLM to:
- Take conversation history + latest user message.
- Produce JSON: `{ "standaloneQuery": "...", "searchQueries": ["q1", "q2", "q3"] }`.
- Each query focused on a distinct aspect, using standard academic terminology, max 3 queries.

**Consumed by**: `src/lib/search/academicSearch/classifier.ts` -> `classifyAcademicQuery()`, which formats the last 6 history items, invokes LLM, extracts JSON (handles markdown wrapping), returns `ClassifierOutput`. Falls back to original query if parsing fails.

### `academicFilterPrompt` (string constant)

Instructs the LLM to act as a strict relevance judge:
- Reviews title + abstract of each search result.
- Returns JSON array of integer indices for relevant documents (e.g. `[0, 2, 4]`), or empty array.
- Highly selective: only keeps documents providing direct or strong background information.

**Consumed by**: `src/lib/search/academicSearch/filter.ts` -> `filterRelevantChunks()`. Safety: if filter returns empty but originals existed, falls back to top 3 chunks. If parsing fails, returns all original chunks.

### `getAcademicWriterPrompt(context, systemInstructions)` (function)

Generates the synthesis system prompt. Key requirements:
- Use inline citations `[1]`, `[2]` for every factual claim, placed after claim before period.
- Do NOT create bibliography (system handles it).
- Start directly with introduction (no top-level title).
- Use Markdown formatting (##, bold, italics, bullets).
- End with "Takeaways" section.
- Injects current UTC date and optional user system instructions.

**Consumed by**: `src/lib/search/academicSearch/agent.ts` -> `executeSearch()`, which builds context from filtered chunks with source numbering, then streams LLM response.

### Full Academic Pipeline Flow

```
User Query -> classifyAcademicQuery (classifier prompt)
  -> standaloneQuery + searchQueries (1-3)
  -> parallel searchSearxng() per query (arxiv, google scholar, pubmed)
  -> deduplicate by URL, limit to 45
  -> filterRelevantChunks (filter prompt), limit to 15
  -> sort by reputable publishers (nature.com, science.org, sciencedirect.com, etc.)
  -> emit sources to client
  -> getAcademicWriterPrompt (writer prompt) with context
  -> stream LLM response with inline citations
  -> persist to DB (academicSearches table)
```

---

## 9. `relatedPapers/`

Files: [abstractEmbedding.ts](src/lib/relatedPapers/abstractEmbedding.ts), [graph.ts](src/lib/relatedPapers/graph.ts).

### Purpose

Implements the **Snowball Graph algorithm** for finding papers related to a given academic paper. Integrates with the Semantic Scholar API to build a citation/reference network and ranks papers using bibliographic coupling, co-citation analysis, and optional embedding-based semantic ranking.

### Embedding Utilities (`abstractEmbedding.ts`)

- **`getEmbeddings(texts)`** -- Resolves embedding model from config/registry, embeds batch of text abstracts. Returns `number[][] | null` (graceful failure).
- **`cosineSimilarity(a, b)`** -- Dot product / (norm(a) * norm(b)). Returns 0 if either vector has zero norm.

### Core Algorithm (`graph.ts`)

#### Constants & Configuration

- `S2_BASE = "https://api.semanticscholar.org/graph/v1"`.
- `S2_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY` (optional; enables 9 req/s vs 0.65 anonymous).
- `MAX_EDGES = 500` per paper, `CACHE_TTL_MS = 90 days`.
- `ACADEMIC_DOMAINS` -- 23 recognized academic publisher domains.

#### Types

- **`RankedPaper`** -- Final output per paper: `paperId`, `title`, `url`, `snippet` (250-char abstract), `authors`, `year`, `venue`, `domain`, `isAcademic`, `score` [0,1], `bcScore`, `ccScore`, `depth`.
- **`RelatedPapersResponse`** -- `pdfTitle`, `pdfDoi`, `seedPaperId`, `rankedPapers[]`, `totalCandidates`, `resolvedCitations`, `rankMethod`, `embeddingModel?`.
- **`SnowballConfig`** -- `depth?` (default 1), `maxPapers?` (default 50), `bcThreshold?`, `ccThreshold?`, `rankMethod?` ("bibliographic"/"embedding"), `embeddingThreshold?`, `seedPaperS2Id?`.

#### Three-Layer Caching

1. **Edge cache** (`paperEdgeCache` table): references/citations per paper.
2. **Metadata cache** (`paperMetadataCache` table): title, abstract, externalIds.
3. **Embedding cache** (`paperAbstractEmbeddings` table): per-model embeddings with composite key (paperId, modelKey). Allows model switching without re-embedding.

All caches have 90-day TTL. Non-fatal on write errors.

#### Rate Limiter

Custom `RateLimiter` class. `throttle()` waits to respect rate limit before each request. S2 API helpers (`s2Get`, `s2Post`) include exponential backoff retry (3 attempts), 15-30s timeouts, and 429 rate-limit tracking.

#### `buildSnowballGraph(pdfTitle, pdfDoi?, config?)` -- 9-Phase Algorithm

**Phase 1 (Seed Resolution)**: If `seedPaperS2Id` provided, skip API. Otherwise `s2ResolveSeed()` tries DOI lookup first, falls back to title search. Returns early if no seed found.

**Phase 2 (Seed References)**: `s2FetchEdgeIds(seedId, "references")`. Stores reference set for BC scoring.

**Phase 3 (Seed Citations)**: `s2FetchEdgeIds(seedId, "citations")`. Used for CC scoring proxy.

**Phase 4 (Frontier Expansion)**: Iterates depth 0 to configured depth. Each layer uses `s2FetchEdgesBatch()` (efficient POST: refs + citations for up to 500 papers in one call). **Scoring per candidate**:
- **Bibliographic Coupling (BC)**: Overlap between candidate's references and seed's references, normalized by max(seed refs, 1).
- **Co-Citation (CC)**: Overlap between candidate's citations and papers citing seed, normalized by max(seed citations, 1).
- **Combined**: `0.5 * bcScore + 0.5 * ccScore`.
Filters by `bcThreshold` and `ccThreshold`.

**Phase 5-6 (Selection)**: Sorts by combined score, takes top-K (1000 if embedding mode, else maxPapers).

**Phase 7 (Metadata Fetch)**: `s2BatchMetadata()` for top-K. 3-second cooldown if no API key.

**Phase 8 (Build RankedPaper[])**: Maps candidates with domain, URL (priority: ArXiv > DOI > PubMed > generic), authors (up to 3 + "et al."), 250-char abstract snippet.

**Phase 9 (Optional Embedding Re-ranking)**: Only if `rankMethod === "embedding"`. Gets seed embedding (or from cache), embeds each candidate's abstract (checking per-model cache first), computes cosine similarities, normalizes scores from [minSim, maxSim] -> [0, 1], filters by `embeddingThreshold`, sorts descending, takes final `maxPapers`. Zeros out BC/CC scores. Caches new embeddings.

#### Public Entry Point

**`buildRelatedPapersGraph(method, pdfTitle, pdfDoi?, config?)`** -- Dispatcher. Currently only supports `GraphConstructionMethod.Snowball`.

### Dependencies

- `@/server/index` (configManager), `@/server/providerRegistry` (modelRegistry).
- `@/server/db` + schema: `paperEdgeCache`, `paperMetadataCache`, `paperAbstractEmbeddings` tables.
- Environment: `SEMANTIC_SCHOLAR_API_KEY` (optional).

---

## 10. `search/`

Files: [index.ts](src/lib/search/index.ts), [baseSearchAgent.ts](src/lib/search/baseSearchAgent.ts), [HNSWSearch.ts](src/lib/search/HNSWSearch.ts), `academicSearch/` subfolder, `webSearch/` subfolder, and `pdfContext/` subfolder.

### Purpose

The complete search infrastructure: academic search using SearXNG + LLM filtering, general web search using SearXNG, and PDF-grounded question answering. All share a streaming architecture for real-time results. Note: Direct code search has been deprecated.

### Module Entry (`index.ts`)

Uses **lazy loading** with `require()` instead of `import` to defer initialization and prevent Next.js from bundling native modules at build time.

- **`getSearchHandlers()`** — Returns singleton `{ default: WebSearchAgent, code: WebSearchAgent }`. The `"code"` key is maintained as an alias for backward compatibility but now routes to the web search pipeline.
- **`getHNSWSearch()`** — Returns the `HNSWSearch` class constructor (used by library search).
- **`formatResultsForPrompt(chunks, contentLabel?)`** — Shared helper that serializes search result chunks into the numbered `Source [n]:\nTitle: ...\nURL: ...\n{contentLabel}: ...` text format consumed by writer prompts. Used by `webSearch/agent.ts` (`"Content"`), `academicSearch/agent.ts` (`"Abstract"`), and the Copilot bridge.

### Abstract Base (`baseSearchAgent.ts`)

**`BaseSearchAgent`** defines the search template:

- **`searchAndAnswer(message, history, llm, systemInstructions, searchRetrieverChainArgs?)`** — Main entry. Creates EventEmitter, sets `statusEmitter`, creates answering chain via LangChain `RunnableSequence`, streams events via `handleStream()`. Returns EventEmitter (non-awaited stream runs asynchronously).

- **`createAnsweringChain()`** — Builds chain: `RunnableMap` (prepares systemInstructions, query, chat_history, date, context) -> `ChatPromptTemplate` -> LLM -> `StringOutputParser`. The `context` field is computed by calling subclass `createSearchRetrieverChain()` then `processDocs()`.

- **`SearchStatus`** — `{ stage: "analyzing" | "searching" | "embedding" | "retrieving" | "generating", message, details? }`.

### Web Search (`webSearch/`)

Files: [agent.ts](src/lib/search/webSearch/agent.ts), [classifier.ts](src/lib/search/webSearch/classifier.ts), [types.ts](src/lib/search/webSearch/types.ts).

**`WebSearchAgent`** implements general web search:

1. **Classification**: Uses the chat history and user query to generate up to 3 targeted search queries for general web engines.
2. **Search**: Queries SearXNG in parallel using the `"general"` category.
3. **Synthesis**: Deduplicates results by URL, caps at 10 sources, and streams a grounded response using the `webWriterPrompt`.

**`preprocessWebSearch(query, history, llm?)`** — Preprocessing-only variant for MCP and Copilot bridge. Runs steps 1–2 (classification + SearXNG search + dedup + cap) and returns `{ standaloneQuery, searchResults, sources }`. No LLM response generation. When `llm` is provided, the classifier reformulates the query for better search results; when omitted (e.g. Copilot bridge), the raw user query is used directly as the SearXNG search query. The full agent's `executeSearch()` delegates to this function internally.

### Academic Search (`academicSearch/`)

Files: [agent.ts](src/lib/search/academicSearch/agent.ts), [classifier.ts](src/lib/search/academicSearch/classifier.ts), [filter.ts](src/lib/search/academicSearch/filter.ts), [types.ts](src/lib/search/academicSearch/types.ts).

Executes a specialized research pipeline:

1. **Classification**: Generates targeted queries for academic databases (arXiv, Google Scholar, PubMed).
2. **Retrieval**: Parallel SearXNG queries with academic-only engines.
3. **Refinement**: Uses the LLM as a judge to filter the top 45 results down to the most relevant ~15 sources based on title and abstract.
4. **Synthesis**: Streams a technical response with strict inline citation requirements.

**`preprocessAcademicSearch(query, history, llm?)`** — Preprocessing-only variant for MCP and Copilot bridge. Runs steps 1–2 (classification + SearXNG search + dedup + cap to 45 + reputable publisher sort) and returns `{ standaloneQuery, filteredResults, sources }`. Skips the LLM-as-judge filtering step — returns all deduplicated results for the external agent to judge relevance itself. When `llm` is provided, the classifier reformulates the query; when omitted (e.g. Copilot bridge), the raw user query is used directly. The full agent's `executeSearch()` delegates to this function for the search phase, then applies LLM filtering on top.

### PDF Context Search (`pdfContext/`)

Files: [agent.ts](src/lib/search/pdfContext/agent.ts). Paper reconstruction logic lives in [`src/lib/paperReconstructor/`](src/lib/paperReconstructor/index.ts) (shared with the upload pipeline).

**`preprocessPdfContext()`** — Preprocessing-only variant for MCP. Fetches paper metadata and sections (`main_text`, `figure_captions`) from the database, reconstructs combined text with paper headers, and builds source metadata. Returns `{ message, reconstructedText, sources }`. No LLM call, no DB writes. The full agent's `execute()` delegates to this function for the data-fetching phase.

**`PdfContextAgent`** provides question-answering grounded exclusively in user-uploaded PDF content:

1. **Query Embedding**: Embeds the user's query via `embedQuery()` (configured default embedding model).
2. **Chunk Retrieval**: Fetches all chunks from `paperChunks` for the selected `paperIds`. Loads embeddings from `paperChunkEmbeddings` (per-model cache), falling back to the legacy `paperChunks.embedding` column.
3. **Cosine Ranking**: Ranks chunks by cosine similarity against the query vector using `computeSimilarity()`, applies configurable score threshold and top-K limit. The embeddings search serves as a *relevance filter* — it determines which papers to include, not which chunks to display.
4. **Full Paper Loading**: Maps top-scoring chunks back to their source `paperId`, then loads the full `.ocr.json` file from disk for each relevant paper (path derived as `filePath.replace(/\.pdf$/i, "") + ".ocr.json"`). For papers without OCR results, falls back to the `papers.abstract` column. Papers are sorted by best chunk score descending.
5. **Section-Based Retrieval**: Before reconstructing on-the-fly, checks the `paperSections` table for pre-computed sections (keyed by `paperId + sectionType`). If cached sections exist, loads them directly — skipping OCR parsing and figure extraction entirely. If no cached sections exist (**lazy backfill**), reconstructs via `PaperReconstructor.reconstructSections()` and persists the results to `paperSections` for future queries. Sections are: `main_text` (body text + figure captions + tables + formulas), `methods` (content under Methods/Materials/Experimental headings, null if none detected), `references` (parsed numbered reference list), and `figures` (JSON array of `{ filename, caption, pageIndex, docOrder }` entries). Section boundary detection uses heuristic matching on `paragraph_title` block content against known methods/references heading patterns (case-insensitive).
6. **System Prompt**: Instructs the LLM to answer using ONLY the provided paper contents, with inline citation requirements (`[Paper 1]`, `[Paper 2]`, etc.). Includes guidance on reading OCR JSON structure (`block_label` / `block_content`), with hints about useful labels: `"figure_title"` for identifying key experimental systems, `"paragraph_title"` for navigation, `"table"` for results summaries, etc. **Temporary**: includes a testing instruction for the model to regurgitate raw OCR JSON contents (to be removed in TODO #3).
7. **Streaming**: Emits the standard `status → sources → response → end` event sequence via EventEmitter, with `"loading"` and `"reconstructing"` status stages while reading OCR files and running paper reconstruction. Sources report `sectionType` as `"full_ocr"` or `"abstract"` per paper. **Temporary**: the LLM is bypassed — reconstructed paper contents are emitted directly as the response for visual verification (TODO #4 testing mode).

**`PaperReconstructor`** (`src/lib/paperReconstructor/index.ts`) transforms an `OCRDocument` into structured Markdown:
- **`reconstruct()`** — Returns a single monolithic Markdown string (all sections joined). Used for backward-compatible full-document rendering.
- **`reconstructSections()`** — Returns `{ mainText, methods, references, figureCaptions, figures }`. Section splitting uses `paragraph_title` blocks: when a heading matches known methods patterns (e.g., "Methods", "Materials and Methods", "Experimental Section", "Computational Methods"), subsequent blocks are routed to the `methods` accumulator until a non-methods heading is encountered. References are detected similarly and parsed via `parseReferences()`. Figure captions (`figure_title` blocks) and sub-panel descriptions (text blocks matching `(A) ...`, `(B) ...`, etc.) are routed to a dedicated `figureCaptions` section, separate from `mainText`.
- Iterates through pages and `parsing_res_list` blocks in document order.
- Text-based blocks are converted to Markdown inline; `display_formula` blocks preserve `$$...$$` delimiters for KaTeX rendering.
- `image`/`chart` blocks are clustered by spatial proximity (Union-Find with dilated overlap + vertical gap heuristics), then batch-extracted as PNGs via a single PyMuPDF subprocess per paper. Extraction regions use normalized bounding box coordinates with 1% padding at 2× zoom.
- Extracted figures are cached as `{pdfBasename}_extracted_p{page}_f{index}.png` alongside the source PDF.
- Figure captions are associated by spatial proximity to the nearest `figure_title` block below each cluster.
- **Noise filtering** — Three heuristics remove OCR artifacts from all reconstructed output:
  1. **Header/footer detection**: A label-agnostic pre-scan identifies short text strings that repeat near the top or bottom 12% of 3+ pages (e.g., journal names, citation lines). These are excluded regardless of their OCR label.
  2. **Sub-panel description reclassification**: Text blocks starting with `(A) ...`, `(B) ...`, `(C and D) ...` patterns are recognized as figure sub-panel descriptions mislabeled as `text` by OCR, and routed to `figureCaptions` instead of `mainText`.
  3. **In-figure text filtering**: Blocks whose bounding box overlaps >30% with any `image`/`chart` block on the same page are skipped entirely. This removes panel labels ("A", "B"), axis titles, and annotations embedded within figure artwork.
- The `/api/papers/[id]/extracted-figure/[filename]` route serves cached figure PNGs with path-traversal protection.

**Background Reconstruction Pipeline** (`src/lib/embed/paperProcess.ts`):
- **`queuePaperReconstruction()`** — Fire-and-forget function called from the upload route after OCR processing. Uses the same `globalThis`-based async queue pattern as `queuePaperEmbedding()` to serialize reconstruction work. Runs independently of (and concurrently with) the embedding queue.
- After reconstruction, upserts results into the `paperSections` table (unique index on `paperId + sectionType`). Errors are logged but never affect paper status — a failed reconstruction does not block uploads or other papers.
- **`POST /api/papers/reconstruct-all`** — Bulk backfill endpoint that iterates over all `status = "ready"` papers with OCR JSON on disk but no `paperSections` rows, and queues them for reconstruction. Returns `{ queued, skippedHasSections, skippedNoOcr, total }`.

**Database Table: `paperSections`** (`src/server/db/schema.ts`):
- Columns: `id` (PK), `paperId` (FK → papers, cascade delete), `sectionType` (enum: `main_text`, `methods`, `references`, `figures`), `content` (text/JSON), `createdAt`.
- Unique index on `(paperId, sectionType)` — at most one row per section per paper.
- For `figures` section type, `content` is a JSON array of `{ filename, caption, pageIndex, docOrder }` objects; all other types store Markdown strings.

**LaTeX Rendering** (chat UI): The `MathBlock` component (`src/components/MathBlock.tsx`) adds KaTeX math rendering to `MessageBox`. A `preprocessMath()` function converts `$$...$$` and `$...$` delimiters into custom `<mathblock>` / `<mathinline>` HTML tags with base64-encoded LaTeX content (preventing markdown-to-jsx from mangling special characters). These are registered as `markdown-to-jsx` overrides and rendered client-side via `katex.renderToString()`. KaTeX CSS is imported globally in `layout.tsx`.

**Integration**: The chat route (`/api/chat`) detects `attachedPaperIds` in the request body and routes to `PdfContextAgent` instead of the default web search agent. The client-side `PdfSelector` component (in `messageActions/`) provides a popover listing all `status = "ready"` papers for toggle-based selection, stored as `attachedPaperIds` in chat context.

## 11. `copilot/`

Files: [bridge.ts](src/lib/copilot/bridge.ts).

### Purpose

Bridges GoFetch's chat pipeline to a headless GitHub Copilot CLI instance, allowing Copilot to serve as the LLM backend. The MCP server (`src/server/mcp/`) runs alongside so Copilot can also call GoFetch tools autonomously.

### Exported Constructs

- **`spawnCopilot(prompt, options?)`** — Low-level utility. Spawns the Copilot CLI (`COPILOT_COMMAND` env var, default `"copilot"`) with the full prompt piped through stdin. Returns an `EventEmitter` emitting the standard `"data"` / `"end"` events compatible with `handleEmitterEvents` in the chat route. Model selection via `options.model` or `COPILOT_MODEL` env var.

- **`handleCopilotChat(params)`** — High-level handler called by the chat route when `chatModel.providerId === "copilot"`. Preprocesses based on the focus mode, builds the full prompt using the existing prompt templates from `src/lib/prompts/`, and spawns Copilot.

### Request Flow

When the chat route receives `providerId: "copilot"`:

1. **PDF context** (`attachedPaperIds` present): Calls `preprocessPdfContext()` to fetch paper text from DB, builds the system prompt via `getPdfOrganizerPrompt()`, spawns Copilot with the combined prompt. Sources are emitted immediately.

2. **Web search** (`focusMode === "default"`): Calls `preprocessWebSearch()` (without an LLM — raw query fallback) to gather SearXNG results, emits sources, builds a grounded prompt via `getWebWriterPrompt()`, and spawns Copilot. If SearXNG is unavailable, emits an error and stops.

3. **Academic search** (`focusMode === "academic"`): Same as web but uses `preprocessAcademicSearch()` and `getAcademicWriterPrompt()`. The full response is buffered (not streamed). After Copilot finishes, `extractCitedSources()` prunes to only cited sources and `remapCitationsInText()` renumbers citations to match the compact source list. Sources and the complete response are emitted together so the client never sees uncited sources.

4. **Code / generic** (any other `focusMode`, e.g. `"code"`): Spawns Copilot directly with a lightweight markdown formatting instruction (`COPILOT_MARKDOWN_PROMPT`) and the user's message — no SearXNG dependency. This ensures the response renders well in the markdown-to-jsx chat window regardless of which Copilot-backed model is active.

### Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COPILOT_COMMAND` | `copilot` | CLI binary to invoke |
| `COPILOT_MODEL` | *(none)* | Model to use (e.g. `claude-sonnet-4.5`) |

### Integration

The chat route (`/api/chat`) checks `chatModel.providerId` before loading an LLM. When `"copilot"`, it bypasses the model registry entirely and delegates to `handleCopilotChat()`. The returned EventEmitter feeds into the same `handleEmitterEvents` → streaming response → DB persistence pipeline used by all other agents, so the frontend requires no changes.

