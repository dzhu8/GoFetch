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
