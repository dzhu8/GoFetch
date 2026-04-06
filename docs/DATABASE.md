# Database

SQLite database (`data/db.sqlite`) accessed via Drizzle ORM with `better-sqlite3`. Foreign keys are enabled. Some cache tables are created inline at startup rather than through migrations.

---

## Chat

### messages
Stores individual chat messages (user, assistant, or source).

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| role | text | "assistant", "user", or "source" |
| chatId | text | References the parent chat |
| messageId | text | Unique message identifier |
| content | text | Message body |
| sources | json | Array of LangChain `Document` objects |
| createdAt | text | Timestamp, defaults to `CURRENT_TIMESTAMP` |

### chats
Top-level chat conversations.

| Column | Type | Notes |
|--------|------|-------|
| id | text | PK |
| title | text | |
| createdAt | text | |
| files | json | Array of `{ name, fileId }` attached files |

### academicSearches
Persisted academic search results tied to a chat.

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| chatId | text | |
| query | text | |
| sources | json | Array of `{ pageContent, metadata: { title, url, ... } }` |
| response | text | LLM-generated answer |
| createdAt | text | |

---

## Paper Library

### libraryFolders
Organizational folders for academic papers (separate from code folders).

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| name | text | Unique |
| rootPath | text | Filesystem storage path |
| createdAt | text | |
| updatedAt | text | |

### papers
Uploaded academic papers with metadata.

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| folderId | integer | FK → libraryFolders.id (cascade delete) — canonical folder |
| fileName | text | |
| filePath | text | Path to PDF |
| title | text | Extracted or fetched |
| doi | text | |
| abstract | text | |
| semanticScholarId | text | S2 paper ID |
| citation | text | Formatted citation string |
| firstFigurePath | text | Filename key for Figure 1 in extracted_figures table |
| status | text | "uploading", "processing", "ready", "error" |
| createdAt | text | |
| updatedAt | text | |

### paperFolderLinks
Many-to-many links for papers that appear in multiple library folders. The canonical folder is on `papers.folderId`; rows here represent secondary/cross-folder links.

| Column | Type | Notes |
|--------|------|-------|
| paperId | integer | FK → papers.id (cascade delete) |
| folderId | integer | FK → libraryFolders.id (cascade delete) |
| createdAt | text | |

PK: (paperId, folderId)

### extractedFigures
Extracted figure images stored as blobs. Includes both the first figure thumbnail and all batch-extracted figures from paper reconstruction. Cascade-deleted when the parent paper is removed.

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| paperId | integer | FK → papers.id (cascade delete) |
| filename | text | Logical filename key (e.g. `paper_fig1.png`, `paper_extracted_p2_f0.png`) |
| pageIndex | integer | Source PDF page |
| docOrder | integer | Position in document for ordering |
| caption | text | Figure caption from OCR |
| imageData | blob | PNG image bytes |
| createdAt | text | |

**Unique constraint:** (paperId, filename)

### paperChunks
OCR-extracted text chunks from papers, used for embedding and search.

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| paperId | integer | FK → papers.id (cascade delete) |
| sectionType | text | e.g. "abstract", "figure_title", "text" |
| chunkIndex | integer | Order within paper |
| content | text | Chunk text |
| embedding | blob | Legacy single-model embedding |
| createdAt | text | |

### paperChunkEmbeddings
Per-model embedding cache for paper chunks, allowing model comparison without re-embedding.

| Column | Type | Notes |
|--------|------|-------|
| chunkId | integer | FK → paperChunks.id (cascade delete) |
| modelKey | text | Embedding model identifier |
| embedding | blob | Float32Array vector |
| createdAt | integer | Unix timestamp |

PK: (chunkId, modelKey)

---

## Related Papers (Citation Graph)

### relatedPapers
Computed related-paper results for library papers, ranked by bibliographic coupling or embedding similarity.

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| paperId | integer | FK → papers.id (cascade delete) — the seed paper |
| title | text | |
| authors | text | |
| year | integer | |
| venue | text | |
| abstract | text | |
| doi | text | |
| semanticScholarId | text | |
| relevanceScore | real | Combined ranking score |
| bcScore | real | Bibliographic coupling score |
| ccScore | real | Co-citation score |
| rankMethod | text | "bibliographic" or "embedding" |
| embeddingModel | text | Model key (null for bibliographic) |
| depth | integer | Graph depth at which paper was found |
| createdAt | text | |

Unique index: (paperId, semanticScholarId, rankMethod) — allows both ranking methods to coexist.

### relatedRuns
Audit log of related-paper computation runs.

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| paperId | integer | FK → papers.id (cascade delete) |
| rankMethod | text | |
| embeddingModel | text | |
| configJson | json | Full config snapshot used for this run |
| resultsCount | integer | Number of results produced |
| completedAt | text | |

---

## Semantic Scholar Cache

### paperEdgeCache
Cached citation/reference edges from the Semantic Scholar API.

| Column | Type | Notes |
|--------|------|-------|
| paperId | text | PK — S2 paper ID |
| referencesJson | text | JSON array of referenced paper IDs |
| citationsJson | text | JSON array of citing paper IDs |
| fetchedAt | integer | Unix timestamp |

### paperMetadataCache
Cached paper metadata from Semantic Scholar.

| Column | Type | Notes |
|--------|------|-------|
| paperId | text | PK — S2 paper ID |
| dataJson | text | Full S2 metadata JSON |
| title | text | Denormalized for quick lookup |
| abstract | text | Denormalized for embedding |
| embedding | blob | Legacy single-model embedding |
| embeddingModel | text | Legacy — model that produced the embedding above |
| fetchedAt | integer | Unix timestamp |

### paperAbstractEmbeddings
Per-model abstract embedding cache. One vector per (S2 paper, model) pair so switching models doesn't require re-embedding.

| Column | Type | Notes |
|--------|------|-------|
| paperId | text | S2 paper ID |
| modelKey | text | Embedding model identifier |
| embedding | blob | Float32Array vector |
| createdAt | integer | Unix timestamp |

PK: (paperId, modelKey)

### paperSourceLinks
Links cached S2 papers back to the uploaded library papers that discovered them, with graph depth.

| Column | Type | Notes |
|--------|------|-------|
| s2PaperId | text | S2 paper ID |
| sourcePaperId | integer | FK → papers.id (cascade delete) |
| depth | integer | 0 = seed paper, 1 = direct ref/citation, etc. |

PK: (s2PaperId, sourcePaperId)

### doiRelatedResultsCache
Cached related-paper results computed via DOI (CLI endpoint) without a local library paper.

| Column | Type | Notes |
|--------|------|-------|
| s2PaperId | text | S2 paper ID of the seed |
| doi | text | |
| rankMethod | text | "bibliographic" or "embedding" |
| resultsJson | text | Full results JSON |
| seedTitle | text | |
| embeddingModel | text | Model key (null for bibliographic) |
| createdAt | integer | Unix timestamp |

PK: (s2PaperId, rankMethod)

---

## Search Cache

### librarySearchCache
Cached library search results, keyed by query + folder set + scope + model + settings.

| Column | Type | Notes |
|--------|------|-------|
| id | integer | PK |
| query | text | Standardized (lowercase) query |
| folderIdsJson | text | Sorted JSON array of folder IDs |
| searchScope | text | "papers", "web_abstracts", or "both" |
| modelKey | text | Embedding model used |
| settingsHash | text | Hash of relevant app settings |
| resultsJson | text | Full results JSON |
| createdAt | integer | Unix timestamp |

Unique index: (query, folderIdsJson, searchScope, modelKey, settingsHash)

---

## Settings

### appSettings
Key-value store for application configuration (models, preferences, personalization).

| Column | Type | Notes |
|--------|------|-------|
| key | text | PK |
| value | json | |
| updatedAt | text | |
