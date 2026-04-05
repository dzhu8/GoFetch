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
2. **State init** -- Sets `loading = true`, `messageAppeared = false`. On first message, updates URL to `/c/{chatId}`.
3. **User message** -- Immediately adds a `UserMessage` to local state.
4. **POST `/api/chat`** -- Sends message content, chatId, fileIds, chat history (optionally sliced for rewrites), chatModel `{key, providerId}`, embeddingModel `{key, providerId}`, and systemInstructions.
5. **Stream response** -- Reads `response.body` chunk-by-chunk via `TextDecoder`, parses newline-delimited JSON. Each message has a `type` field:
   - `"error"` -- Toast notification, reset loading/searchStatus, return.
   - `"status"` -- Updates `searchStatus` for UI progress indicators (analyzing, searching, embedding, retrieving, generating).
   - `"sources"` -- Clears searchStatus, marks `messageAppeared = true`, adds `SourceMessage` containing retrieved documents.
   - `"message"` -- First chunk creates a new `AssistantMessage`; subsequent chunks append to it. Content is tracked in a `recievedMessage` variable.
   - `"messageEnd"` -- Finalizes: updates `chatHistory` with `[human, message]` + `[assistant, recievedMessage]`, resets loading/searchStatus. Then checks if suggestions are needed: finds the user message index, the source message, and the suggestion message index. If sources exist AND no suggestions yet, calls `getSuggestions()` (from `../output/suggestions/actions`) and adds a `SuggestionMessage`.

#### `sendAcademicSearch()` (Academic Mode)

Nearly identical to `sendMessage()` but POSTs to `/api/academic-search` with `query` instead of `content`, has no file support, no auto-suggestions logic, and does not update history until `messageEnd`.

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

**`chunkFolderRegistration(registration, options?)`** -- Calls `listSupportedTextFiles()` then `chunkFiles()`. This is the main entry point consumed by `src/lib/embed/initial.ts` -> `ensureTextChunkSnapshots()`.

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

Files: [types.ts](src/lib/embed/types.ts), [progress.ts](src/lib/embed/progress.ts), [paperProcess.ts](src/lib/embed/paperProcess.ts), [initial.ts](src/lib/embed/initial.ts).

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

### Initial Folder Embeddings (`initial.ts`)

#### `scheduleInitialEmbedding(folder)`

Main async scheduling function with cancellation support:

1. Cancel existing job for the folder (sets `job.cancelled = true`).
2. Update progress to `"parsing"`.
3. Call `ensureTextChunkSnapshots(folder)` -- checks `textChunkSnapshots` table; if missing, calls `chunkFolderRegistration(folder)` from `../chunk`, generates SHA256 hashes of file paths, inserts chunk records in transaction.
4. Call `embedFolderFromSnapshots(folderName, options)`:
   - `collectTextChunkDocuments()` -- queries `textChunkSnapshots`, formats each chunk with path/format/span/content metadata, creates labels (first 50 chars).
   - `resolveEmbeddingPreferenceFromSettings()` -- gets embedding model preference.
   - `deleteExistingInitialEmbeddings(folderName)` -- batch deletes existing "initial" stage embeddings (500-item chunks to avoid SQLite variable limits).
   - Routes to either `embedWithSummarization()` or `embedDirectly()` based on `getEmbedSummariesPreference()`.

#### `embedWithSummarization()` Path

1. **Summarization** (batch size = 8): For each batch, calls `summarizeDocumentBatch(chatModel, batch)`. Each chunk gets a prompt with file path, format, and original content. The system prompt instructs the LLM to focus on what makes the snippet DISTINCT, include algorithm/function names, keep under 200 words, use searchable natural language, omit code syntax. Falls back to original content on failure. Tracks output tokens.
2. **Embedding** (batch size = 64): Embeds summaries via `embeddingModel.embedDocuments()`. Stores vectors with metadata: `stage="initial"`, `type="text-chunk"`, format, chunkIndex, label, original content.
3. **Batch insert** (chunk size = 50): Transaction inserts to `embeddings` table.

#### `embedDirectly()` Path

Skips summarization, embeds original chunk content directly (batch size = 64), same insert pattern.

#### `cancelInitialEmbedding(folderName)`

Sets cancellation flag, clears progress. Multiple cancellation checks throughout the pipeline prevent wasted API calls.

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

Files: [types.ts](src/lib/models/types.ts), [modelPreference.ts](src/lib/models/modelPreference.ts), [ollamaClient.ts](src/lib/models/ollamaClient.ts), [preferenceResolver.ts](src/lib/models/preferenceResolver.ts), and `providers/` subfolder with [BaseModelProvider.ts](src/lib/models/providers/BaseModelProvider.ts), [OpenAIProvider.ts](src/lib/models/providers/OpenAIProvider.ts), [AnthropicProvider.ts](src/lib/models/providers/AnthropicProvider.ts), [OllamaProvider.ts](src/lib/models/providers/OllamaProvider.ts), [PaddleOCRProvider.ts](src/lib/models/providers/PaddleOCRProvider.ts).

### Purpose

Multi-provider LLM/embedding/OCR abstraction layer. Defines the contract for model providers, implements concrete providers for OpenAI, Anthropic, Ollama, and PaddleOCR, and provides preference resolution with fallback logic.

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

### PaddleOCR Provider (`PaddleOCRProvider.ts`)

OCR-only. Single curated model: `PaddleOCR-VL` (requires GPU/CUDA). `loadOCRModel()` returns lightweight `{ modelKey, providerType: "paddleocr" }` (signals configuration, doesn't instantiate native code). Chat and embedding methods throw.

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

## 8. `outputParsers/`

Files: [fileLinksOutputParser.ts](src/lib/outputParsers/fileLinksOutputParser.ts), [lineOutputParser.ts](src/lib/outputParsers/lineOutputParser.ts).

### Purpose

Custom LangChain output parsers that extract structured information from LLM outputs using XML tag delimiters.

### `LineOutputParser` (default export from `lineOutputParser.ts`)

Extends `BaseOutputParser<string | undefined>` from `@langchain/core/output_parsers`.

**Constructor**: `new LineOutputParser({ key?: string })` -- defaults key to `"questions"`.

**`parse(text)`**: Searches for `<${key}>` and `</${key}>` delimiters. Extracts content between them. Strips leading markdown list markers (regex: `^(\s*(-|\*|\d+\.\s|\d+\)\s|\u2022)\s*)+`). Returns the extracted string, or `undefined` if delimiters not found.

**Usage**: In `codeSearchAgent.ts` (instantiated with `key: "question"`) to extract rephrased questions from LLM output. Falls back to full `llmOutput` if parsing returns undefined.

### `FileLinksOutputParser` (default export from `fileLinksOutputParser.ts`)

Extends `BaseOutputParser<FileInfo[]>`.

**Constructor**: `new FileLinksOutputParser({ key?: string })` -- defaults key to `"links"`.

**`parse(text)`**: Extracts content between `<links>` and `</links>`, splits by newline, strips list markers, extracts filename from path (handles `/` and `\`), detects language from extension via `extensionToLanguage` map (supports 40+ languages/formats). Returns `FileInfo[]` with `{ filename, language }`.

**`extensionToLanguage`** covers: JS/TS ecosystem, web technologies, server-side languages (Python, Java, Go, Rust, Ruby, PHP, Swift), data/config formats, database (SQL), markup, functional languages, and frontend frameworks (Vue, Svelte).

**Status**: Currently unused in the codebase (prepared for future functionality).

---

## 9. `prompts/`

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

## 10. `relatedPapers/`

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

## 11. `search/`

Files: [index.ts](src/lib/search/index.ts), [baseSearchAgent.ts](src/lib/search/baseSearchAgent.ts), [HNSWSearch.ts](src/lib/search/HNSWSearch.ts), `academicSearch/` subfolder, `webSearch/` subfolder, and `pdfContext/` subfolder.

### Purpose

The complete search infrastructure: academic search using SearXNG + LLM filtering, general web search using SearXNG, and PDF-grounded question answering. All share a streaming architecture for real-time results. Note: Direct code search has been deprecated.

### Module Entry (`index.ts`)

Uses **lazy loading** with `require()` instead of `import` to defer initialization and prevent Next.js from bundling native modules at build time.

- **`getSearchHandlers()`** — Returns singleton `{ default: WebSearchAgent, code: WebSearchAgent }`. The `"code"` key is maintained as an alias for backward compatibility but now routes to the web search pipeline.
- **`getHNSWSearch()`** — Returns the `HNSWSearch` class constructor (used by library search).

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

### Academic Search (`academicSearch/`)

Files: [agent.ts](src/lib/search/academicSearch/agent.ts), [classifier.ts](src/lib/search/academicSearch/classifier.ts), [filter.ts](src/lib/search/academicSearch/filter.ts), [types.ts](src/lib/search/academicSearch/types.ts).

Executes a specialized research pipeline:

1. **Classification**: Generates targeted queries for academic databases (arXiv, Google Scholar, PubMed).
2. **Retrieval**: Parallel SearXNG queries with academic-only engines.
3. **Refinement**: Uses the LLM as a judge to filter the top 45 results down to the most relevant ~15 sources based on title and abstract.
4. **Synthesis**: Streams a technical response with strict inline citation requirements.

### PDF Context Search (`pdfContext/`)

Files: [agent.ts](src/lib/search/pdfContext/agent.ts).

**`PdfContextAgent`** provides question-answering grounded exclusively in user-uploaded PDF content:

1. **Query Embedding**: Embeds the user's query via `embedQuery()` (configured default embedding model).
2. **Chunk Retrieval**: Fetches all chunks from `paperChunks` for the selected `paperIds`. Loads embeddings from `paperChunkEmbeddings` (per-model cache), falling back to the legacy `paperChunks.embedding` column.
3. **Cosine Ranking**: Ranks chunks by cosine similarity against the query vector using `computeSimilarity()`, selects top 10.
4. **Context Assembly**: Formats chunks as numbered excerpts with section type and paper title metadata.
5. **System Prompt**: Instructs the LLM to answer using ONLY the provided excerpts, with explicit "not relevant" fallback language and inline citation requirements (`[1]`, `[2]`, etc.).
6. **Streaming**: Emits the standard `status → sources → response → end` event sequence via EventEmitter.

**Integration**: The chat route (`/api/chat`) detects `attachedPaperIds` in the request body and routes to `PdfContextAgent` instead of the default web search agent. The client-side `PdfSelector` component (in `messageActions/`) provides a popover listing all `status = "ready"` papers for toggle-based selection, stored as `attachedPaperIds` in chat context.

