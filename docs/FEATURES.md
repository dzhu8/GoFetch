# Features

## 1. Chat & Conversational Search

**API:** `POST /api/chat`, `GET/DELETE /api/chats`, `GET/DELETE /api/chats/[id]`
**Lib:** `lib/search/`

Streamed conversational search with document/code context. The main entry point is `searchAndAnswer()` which takes a user query plus conversation history and generates a streamed LLM response. Supports multiple focus modes (e.g. "code", "academic") via `getSearchHandlers()`, which lazy-loads specialized agents like `CodeSearchAgent`. Chat conversations are persisted and retrievable by ID.

---

## 2. Academic Search

**API:** `POST /api/academic-search`
**Lib:** `lib/search/academicSearch/`

LLM-synthesized academic paper search. Pipeline:
1. `classifyAcademicQuery()` transforms the user query into standalone + search queries
2. Queries SearXNG with multiple academic engines (arXiv, Google Scholar, PubMed) in parallel
3. `filterRelevantChunks()` uses the LLM to judge source relevance
4. Results are prioritized by publisher reputation
5. LLM streams a synthesized answer with inline citations

Emits streaming events: `status`, `sources`, `response`, `messageEnd`.

---

## 3. Library Management (Papers & Folders)

**API:**
- Folders: `GET/POST /api/library-folders`, `GET/DELETE /api/library-folders/[id]`
- Papers: `GET /api/papers?folderId=N`, `GET/DELETE /api/papers/[id]`
- Upload: `POST /api/papers/upload`, `DELETE /api/papers/upload/[id]`
- Assets: `GET /api/papers/[id]/pdf`, `GET /api/papers/[id]/figure`
- Embeddings: `GET/POST/DELETE /api/papers/[id]/embeddings`

**Lib:** `lib/embed/paperProcess.ts`, `lib/citations/parseReferences.ts`

Local academic paper library organized into folders. Upload flow (streaming NDJSON progress):
1. PDF uploaded and stored
2. OCR extracts text via PaddleOCR-VL (Python subprocess)
3. `processPaperOCR()` parses OCR output, extracts chunks from allowed sections (abstract, text, figures, tables, formulas), filtering out boilerplate
4. `extractDocumentMetadata()` pulls title and DOI from OCR output
5. Semantic Scholar metadata enrichment (DOI lookup → title search fallback)
6. `extractFirstFigure()` locates "Figure 1" in OCR, crops and saves PNG
7. `queuePaperEmbedding()` queues the paper for embedding

Duplicate detection by title/DOI during upload — reuses cached results across folders. Papers can exist in multiple folders via secondary links.

---

## 4. Related Papers (Snowball/Citation Graph)

**API:**
- `POST /api/related-papers` — build citation graph (optional streaming)
- `GET /api/related-papers/cache` — list cached papers
- `GET /api/related-papers/resolve` — resolve DOI/title to Semantic Scholar ID
- `POST/GET /api/papers/[id]/related-papers` — compute/fetch related papers for a library paper

**Lib:** `lib/relatedPapers/graph.ts`

Multi-phase snowball algorithm via `buildRelatedPapersGraph()`:
1. **Resolve** seed paper (by DOI, title, or known S2 ID)
2. **Expand** — fetch references + citations from Semantic Scholar API (rate-limited)
3. **Recurse** to configured depth
4. **Rank** results by:
   - Bibliographic coupling (BC score)
   - Co-citation proxy (CC score)
   - Optional embedding similarity (cosine distance between abstracts)

Caching: edge cache (refs/citations per paper, 90-day TTL), metadata cache (title/abstract/authors/year, 90-day TTL), per-model abstract embeddings. Rate limiting at 0.65 req/s anonymous or 9 req/s with API key, with exponential backoff on 429s.

---

## 5. Library Search (Hybrid)

**API:** `POST /api/library-search`
**Lib:** `lib/search/` (library search logic)

Hybrid search across two scopes:
- **Papers:** query chunks from library papers in target folders
- **Web abstracts:** Semantic Scholar papers reachable via citation graph (depth ≤ 2)

Embeds the query with the configured model, computes cosine similarity against all candidate vectors, and returns top-N results. Caches full results keyed by query + folder IDs + scope + model + settings hash (~90-day TTL, auto-invalidated on model change). Missing embeddings are computed on-the-fly in batches of 32.

---

## 6. Configuration & Providers

**API:**
- Config: `GET/POST /api/config`, `POST /api/config/setup-complete`
- Providers: `GET/POST /api/providers`, `PATCH/DELETE /api/providers/[id]`, `GET /api/providers/[id]/models`
- Ollama: `GET /api/ollama/models`

**Lib:** `lib/config/`, `lib/models/`

Pluggable model provider system. Providers (Anthropic, OpenAI, Ollama, etc.) are registered with API keys and expose their available models with metadata (size, context window, pricing). Ollama endpoint returns curated + installed models with capability flags.

Key config areas: default embedding/chat models, graph rank method ("bibliographic" or "embedding"), snowball depth/maxPapers, BC/CC/embedding thresholds.

---

## 7. Embeddings

**API:**
- `POST /api/embeddings/query` — embed a single query string
- `POST /api/test-embedding` — compare two strings (returns cosine similarity)
- `POST /api/paper-embeddings` — paper-level embedding management

**Lib:** `lib/embed/`

Embeddings stored as binary Float32Array in SQLite, with per-model caching for papers. `lib/embed/` manages the embedding pipeline including batch processing (size 10 for papers) and queue management via global progress emitters.

---

## 8. CLI Endpoints

**API:** `GET/POST /api/cli/library`, plus CLI variants of related-papers and search

Mirror of web functionality exposed for CLI access. Supports library listing, PDF upload (streaming NDJSON), related-papers search, and DOI-to-S2 resolution — same core logic, different interface.

---

## 9. Supporting Modules

| Module | Path | Purpose |
|--------|------|---------|
| Prompts | `lib/prompts/` | LLM prompt templates for search, classification, filtering |
| Output Parsers | `lib/outputParsers/` | Parse structured LLM responses |
| Citations | `lib/citations/` | Extract metadata (title, DOI) from OCR output |
| SearXNG | `lib/searxng.ts` | SearXNG meta-search engine client |
| Utils | `lib/utils.ts`, `lib/utils/` | Shared utilities |

---

## Architectural Patterns

- **Streaming:** SSE and NDJSON for long-running operations (search, OCR, embedding, graph building)
- **Lazy loading:** Native modules (better-sqlite3) loaded dynamically to avoid bundle bloat
- **Rate limiting:** Custom RateLimiter for Semantic Scholar API throttling with exponential backoff
- **Caching:** Multi-layer — edge/metadata cache for S2 data, per-model embedding cache, search result cache
- **Provider abstraction:** Pluggable LLM/embedding providers with model discovery
- **Duplicate detection:** By title/DOI during paper upload, with cross-folder reuse

## Tech Stack

- **Framework:** Next.js (App Router API routes)
- **Database:** SQLite via Drizzle ORM
- **LLM:** LangChain
- **Web search:** SearXNG (arXiv, Google Scholar, PubMed)
- **OCR:** PaddleOCR-VL (Python subprocess)
- **PDF:** PyMuPDF (fitz)
- **Citations:** Semantic Scholar API
