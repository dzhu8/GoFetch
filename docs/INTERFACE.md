# GoFetch Interface Component Reference

Maps each `src/lib` feature module (documented in [FEATURES.md](FEATURES.md)) to the app interface components that surface its functionality. Organized by feature, then by page-level routes and shared components.

---

## 1. `chat/` → Conversation UI

The `ChatProvider` and `useChat` hook from [Chat.tsx](../src/lib/chat/Chat.tsx) are the backbone of the entire chat interface. Almost every interactive component consumes this context.

### Pages

| Route | Page file | Role |
|-------|-----------|------|
| `/` | [page.tsx](../src/app/page.tsx) | Renders `ChatWindow` as the landing page |
| `/c` | [c/page.tsx](../src/app/c/page.tsx) | Base chat route, renders `ChatWindow` |
| `/c/[chatId]` | [c/[chatId]/page.tsx](../src/app/c/[chatId]/page.tsx) | Dynamic chat session, renders `ChatWindow` |
| `/chats` | [chats/page.tsx](../src/app/chats/page.tsx) | Chat history list with delete; standalone page using `actions/chats` |

### Components

**[ChatWindow.tsx](../src/components/ChatWindow.tsx)** — Top-level chat container. Manages loading/error/not-found states and conditionally renders `EmptyChat` (no messages) or `Chat` (active conversation). Exports shared message types (`AssistantMessage`, `UserMessage`, `SourceMessage`, `SuggestionMessage`, `SearchStatus`, `ChatTurn`, `Message`, `File`).

**[Chat.tsx](../src/components/Chat.tsx)** — Main conversation display. Renders an ordered list of `MessageBox` components for each conversation turn, plus `MessageBoxLoading` and `SearchStatusIndicator` during streaming. Also renders `RelatedPapersPanel` and the follow-up `MessageInput`.

**[MessageBox.tsx](../src/components/MessageBox.tsx)** — Single Q&A turn. Shows the user question, assistant response (rendered via `Markdown` with custom overrides), `MessageSources` for citations, `ThinkBox` for extended thinking, inline `Citation` links, and clickable follow-up `SuggestionMessage` chips. Includes `CopyMessage` and `RewriteMessage` action buttons.

**[MessageBoxLoading.tsx](../src/components/MessageBoxLoading.tsx)** — Animated skeleton placeholder while the assistant response streams in.

**[MessageInput.tsx](../src/components/MessageInput.tsx)** — Follow-up message input. Contains `TextareaAutosize`, `ChatToolDropdown`, and `PdfSelector`. Supports single/multi-line toggle.

**[EmptyChat.tsx](../src/components/EmptyChat.tsx)** — Landing state when no messages exist. Renders `EmptyChatMessageInput` and `SettingsButton`.

**[EmptyChatMessageInput.tsx](../src/components/EmptyChatMessageInput.tsx)** — Initial message input with `ModelSelector`, `ChatToolDropdown`, `PdfSelector`, and academic focus mode indicator.

**[SearchStatusIndicator.tsx](../src/components/SearchStatusIndicator.tsx)** — Animated phase display during search (analyzing, searching, embedding, retrieving, generating). Consumes `SearchStatus` type from `ChatWindow`.

**[ThinkBox.tsx](../src/components/ThinkBox.tsx)** — Collapsible container showing the model's extended thinking/reasoning process.

**[Citation.tsx](../src/components/Citation.tsx)** — Inline citation link rendered inside assistant responses. Styled badge linking to source URL.

---

## 2. `chunk/` → No Direct UI

The chunking pipeline is entirely server-side. It is consumed by `embed/initial.ts` during folder embedding. The only indirect UI visibility is through the embedding progress toasts (see `embed/` below) and the chunk results displayed on the Inspect page.

---

## 3. `citations/` → Reference Extraction & Inline Citations

### Components

**[GetRelatedPapers.tsx](../src/components/messageActions/GetRelatedPapers.tsx)** — Imports `extractDocumentMetadata` from `citations/parseReferences` to pull title/DOI from uploaded PDF OCR output. This metadata feeds the related papers search flow. Two entry paths: DOI text input or PDF upload with OCR.

**[MessageBox.tsx](../src/components/MessageBox.tsx)** — The `sections` memo in `Chat.tsx` performs citation linking (regex `[N]` to `<Citation>` components with source URLs). `MessageBox` renders these inline citations within the assistant response markdown.

**[MessageSources.tsx](../src/components/MessageSources.tsx)** — Displays up to 4 source cards with favicon, title, and URL. Expandable modal for additional sources. Sources are the documents that citation numbers reference.

---

## 4. `config/` → Settings & Setup

### Pages

| Route | Page file | Role |
|-------|-----------|------|
| (setup overlay) | [layout.tsx](../src/app/layout.tsx) | Renders `SetupWizard` if `setupComplete` is false |

### Components

**[SetupWizard.tsx](../src/components/setup/SetupWizard.tsx)** — Animated welcome screen transitioning to `SetupConfig` after 2.5s.

**[SetupConfig.tsx](../src/components/setup/SetupConfig.tsx)** — Multi-step setup wizard (providers, models, Python environment). Imports `config/types` for field schemas. Uses `actions/config`, `actions/providers`, `actions/library`, `actions/paddleocr`.

**[PaddleInstallMonitor.tsx](../src/components/setup/PaddleInstallMonitor.tsx)** — Background monitor for PaddleOCR installation triggered post-setup. Shows progress toasts and success/failure modals.

**[SettingsButton.tsx](../src/components/settings/SettingsButton.tsx)** — Gear icon that opens `SettingsDialogue` with `AnimatePresence`.

**[SettingsDialogue.tsx](../src/components/settings/SettingsDialogue.tsx)** — Modal with sidebar navigation (desktop) / dropdown (mobile) for Preferences and Personalization sections. Fetches config via `actions/config`.

**[Preferences.tsx](../src/components/settings/Preferences.tsx)** — Renders preference fields plus default chat & embedding model selectors via `SettingsDropdown`. Imports `models/types` and `models/modelPreference`.

**[Personalization.tsx](../src/components/settings/Personalization.tsx)** — Renders personalization fields (system instructions, graph parameters) via `SettingsField`.

**[SettingsField.tsx](../src/components/settings/SettingsField.tsx)** — Polymorphic field renderer. Produces `SettingsSelect`, `SettingsInput`, `SettingsTextarea`, `SettingsSwitch`, or `SettingsNumber` based on `UIConfigField` type from `config/types`. Saves on blur/change via `actions/config`.

**[SettingsDropdown.tsx](../src/components/settings/SettingsDropdown.tsx)** — Model selector dropdown used within settings. Imports `models/modelPreference` for persistence.

---

## 5. `embed/` → Embedding Progress & Visualization

### Pages

| Route | Page file | Role |
|-------|-----------|------|
| `/inspect` | [inspect/page.tsx](../src/app/inspect/page.tsx) | 3D embedding visualization, query testing, and embedding management |

### Components

**[TaskProgressProvider.tsx](../src/components/progress/TaskProgressProvider.tsx)** — Context provider that manages SSE streaming from the server for folder embedding progress. Imports `TaskProgressState` from `embed/types`. Tracks phase transitions: parsing, summarizing, embedding, completed.

**[TaskProgressToasts.tsx](../src/components/progress/TaskProgressToasts.tsx)** — Renders toast notifications for active embedding tasks. Shows phase-specific labels, progress counts, and token usage from `TaskProgressProvider`.

**[ThreeEmbeddingViewer.tsx](../src/components/ThreeEmbeddingViewer.tsx)** — Three.js-based 3D point cloud visualization of embedding vectors. Supports UMAP dimensionality reduction, query point overlay, nearest-neighbor lines, orbit controls, and hover/click interactions. Used on the Inspect page.

**Inspect page** ([inspect/page.tsx](../src/app/inspect/page.tsx)) — Three tabs: "Visualize embeddings" (3D viewer), "Visualize query" (embed a query and show nearest neighbors), "Delete embeddings". Uses `actions/embeddings` and `actions/papers` for data, UMAP for projection. Also manages folders via `actions/folders`.

---

## 6. `models/` → Model Selection & Provider Management

### Pages

| Route | Page file | Role |
|-------|-----------|------|
| `/models` | [models/page.tsx](../src/app/models/page.tsx) | Full model/provider management: browse, download, add providers, test embeddings |

### Components

**[ChatModelSelector.tsx](../src/components/messageActions/ChatModelSelector.tsx)** (also aliased as `ModelSelector`) — Dropdown for selecting the active chat and OCR model. Imports `models/modelPreference` for persistence and `models/types` for provider shapes. Shown in `EmptyChatMessageInput`.

**[ModelSelect.tsx](../src/components/setup/modelsView/ModelSelect.tsx)** — Setup-phase model selector for default chat/embedding models. Imports `models/types`, `models/modelPreference`, `chat/Chat`.

**[OllamaModels.tsx](../src/components/setup/modelsView/OllamaModels.tsx)** — Displays locally available Ollama models grouped by family with download progress and chat/embedding toggles. Uses `actions/ollama` and `actions/providers`.

**[ModelFamilyGroup.tsx](../src/components/setup/modelsView/ModelFamilyGroup.tsx)** — Collapsible model family group (Llama, Qwen, Gemma, etc.) with family-specific icons/colors, download actions, and embedding test support. Also used on the Models page.

**[AddProvider.tsx](../src/components/models/AddProvider.tsx)** — Dialog for adding new model provider connections. Dynamically renders config fields based on provider type from `config/types`. Uses `actions/providers`.

**Models page** ([models/page.tsx](../src/app/models/page.tsx)) — Lists all providers and their models (chat, embedding, OCR) with metadata (size, context window, pricing). Supports adding/updating/deleting providers, downloading Ollama models, and testing embeddings via a sample-text modal.

---

## 7. `output/` → Follow-Up Suggestions

### Components

**[MessageBox.tsx](../src/components/MessageBox.tsx)** — Renders `SuggestionMessage` content as clickable chips at the end of an assistant response. Clicking a suggestion calls `sendMessage()` from the chat context.

The suggestion fetch itself (`getSuggestions()`) is invoked inside `Chat.tsx` after the `messageEnd` streaming event. No dedicated suggestion component exists; the display is inline within `MessageBox`.

---

## 8. `outputParsers/` → No Direct UI

`LineOutputParser` and `FileLinksOutputParser` are server-side LangChain output parsers. `FileLinksOutputParser` is currently unused. `LineOutputParser` is consumed in `codeSearchAgent.ts` for query rephrasing. No components reference these modules.

---

## 9. `prompts/` → No Direct UI

System prompts for academic search are consumed server-side by the search pipeline (`classifier.ts`, `filter.ts`, `agent.ts`). The user-facing system instructions textarea in Personalization settings feeds into these prompts but does not import from `prompts/` directly.

---

## 10. `relatedPapers/` → Related Papers Display

### Pages

| Route | Page file | Role |
|-------|-----------|------|
| `/library/papers/[id]/related` | [related/page.tsx](../src/app/library/papers/[id]/related/page.tsx) | Dedicated related papers view with ranking method toggle and score display |

### Components

**[RelatedPapersPanel.tsx](../src/components/RelatedPapersPanel.tsx)** — Sidebar panel in the chat view showing ranked related papers with BC/CC scores, academic domain badges, author lists, and external links. Imports `RelatedPapersResponse` and `RankedPaper` types from `relatedPapers/graph`.

**[GetRelatedPapers.tsx](../src/components/messageActions/GetRelatedPapers.tsx)** — Chat action component for triggering related papers search. Two paths: DOI input or PDF upload with OCR. Includes folder picker, method selector (bibliographic/embedding), and progress modal. Imports `extractDocumentMetadata` from `citations/parseReferences` and uses `actions/related-papers`.

**Related papers page** ([related/page.tsx](../src/app/library/papers/[id]/related/page.tsx)) — Full-page related papers view. Supports toggling between bibliographic (BC+CC) and embedding similarity ranking. Displays scores, depth, venue, authors, and external links. Detects stale results when embedding model changes. Uses `actions/papers` for compute/fetch.

---

## 11. `search/` → Search Execution & Results

### Components

**[SearchStatusIndicator.tsx](../src/components/SearchStatusIndicator.tsx)** — Renders the current search phase during streaming. The phases (`analyzing`, `searching`, `embedding`, `retrieving`, `generating`) correspond to `SearchStatus` events emitted by `baseSearchAgent.ts` and the academic/web/PDF search pipelines.

**[ChatToolDropdown.tsx](../src/components/messageActions/ChatToolDropdown.tsx)** — Contains the academic focus mode toggle. When enabled, `sendMessage()` in `Chat.tsx` delegates to `sendAcademicSearch()`, which POSTs to `/api/academic-search` instead of `/api/chat`.

**[MessageSources.tsx](../src/components/MessageSources.tsx)** — Displays source documents returned by all search pipelines (web, academic, PDF context). Up to 4 cards shown inline; overflow in expandable modal.

**[PdfSelector.tsx](../src/components/messageActions/PdfSelector.tsx)** — Popover listing all `status = "ready"` papers for toggle-based attachment. When papers are attached, the `/api/chat` route activates `PdfContextAgent` instead of web search. Uses `actions/papers` (`listReadyPapers`).

**[LibraryEmbeddingSearchModal.tsx](../src/components/LibraryEmbeddingSearchModal.tsx)** — Modal for semantic search across the library's HNSW index. Folder and embedding model filters, displays chunk and abstract results with similarity scores. Used on the Library folder detail page. Imports `actions/library` and `models/modelPreference`.

---

## 12. Shared Layout & Navigation

### Root Layout

**[layout.tsx](../src/app/layout.tsx)** — Server component wrapping the entire app. Provides context providers in this order: `ThemeProvider` → `ChatProvider` → `TaskProgressProvider` → `PdfParseProvider`. Conditionally renders `SetupWizard` or `Sidebar` + page content. Includes `TaskProgressToasts`, `PdfParseToasts`, `PaddleInstallMonitor`, and `Toaster`.

### Components

**[Sidebar.tsx](../src/components/Sidebar.tsx)** — Main navigation. Fixed sidebar on desktop, bottom bar on mobile. Links: Home, History, Library, Inspect, Models. Includes `SettingsButton`.

**[Layout.tsx](../src/components/Layout.tsx)** — Simple max-width/padding wrapper for page content.

**[Loader.tsx](../src/components/Loader.tsx)** — SVG spinning loader used during initial page loads.

**[Select.tsx](../src/components/Select.tsx)** — Styled `<select>` wrapper with loading spinner, used across settings and setup flows.

---

## 13. Library & Paper Management

### Pages

| Route | Page file | Role |
|-------|-----------|------|
| `/library` | [library/page.tsx](../src/app/library/page.tsx) | Folder list with paper counts, folder creation, PDF upload |
| `/library/[folderId]` | [library/[folderId]/page.tsx](../src/app/library/[folderId]/page.tsx) | Paper list with metadata, actions (cite, related, re-embed, delete), upload |

### Components

**[ParsePDF.tsx](../src/components/messageActions/ParsePDF.tsx)** — Orchestrates PDF upload: folder selection, folder creation, file picker, queues background parse job via `PdfParseProvider`. Imports `actions/library`.

**[PdfParseProvider.tsx](../src/components/progress/PdfParseProvider.tsx)** — Context provider managing a queue of PDF parse jobs (upload + OCR). Sequential processing with `AbortController` cancellation support.

**[PdfParseToasts.tsx](../src/components/progress/PdfParseToasts.tsx)** — Toast display for active and queued PDF parse jobs (uploading, processing, complete).

**[GithubProjectCard.tsx](../src/components/GithubProjectCard.tsx)** — Card showing GitHub project sync stats (files/lines changed). Includes sync button via `actions/folders`. Used on the Sync page.

**Library page** ([library/page.tsx](../src/app/library/page.tsx)) — Lists library folders with paper counts. Supports creating folders, uploading PDFs, and deleting folders.

**Folder detail page** ([library/[folderId]/page.tsx](../src/app/library/[folderId]/page.tsx)) — Lists papers in a folder with title, authors, year, venue. Paper actions: copy citation, search related papers, recompute embeddings, delete. Includes PDF upload, `LibraryEmbeddingSearchModal` for semantic search, and status indicators (uploading/processing/ready/error).

---

## 14. Sync

### Pages

| Route | Page file | Role |
|-------|-----------|------|
| `/sync` | [sync/page.tsx](../src/app/sync/page.tsx) | GitHub repository folder sync with file change stats |

### Components

**[GithubProjectCard.tsx](../src/components/GithubProjectCard.tsx)** — Renders per-folder sync stats and a sync action button.

**Sync page** ([sync/page.tsx](../src/app/sync/page.tsx)) — Lists synced GitHub folders. Add folder via CLI picker or manual input. Polls for CLI folder watcher changes (4s interval). Uses `TaskProgressProvider` for embedding progress after sync.

---

## Component Tree Overview

```
layout.tsx
+-- SetupWizard (if !setupComplete)
|   +-- SetupConfig
|       +-- ModelSelect
|       +-- OllamaModels -> ModelFamilyGroup
|       +-- AddProvider
+-- Sidebar (navigation)
|   +-- SettingsButton -> SettingsDialogue
|       +-- Preferences -> SettingsField, SettingsDropdown
|       +-- Personalization -> SettingsField
+-- PaddleInstallMonitor
+-- TaskProgressToasts (from TaskProgressProvider)
+-- PdfParseToasts (from PdfParseProvider)
+-- [Page Content]
    +-- ChatWindow (/, /c, /c/[chatId])
    |   +-- EmptyChat
    |   |   +-- EmptyChatMessageInput
    |   |       +-- ModelSelector (ChatModelSelector)
    |   |       +-- ChatToolDropdown
    |   |       |   +-- ParsePDF
    |   |       |   +-- GetRelatedPapers
    |   |       +-- PdfSelector
    |   +-- Chat
    |       +-- MessageBox (per turn)
    |       |   +-- MessageSources
    |       |   +-- ThinkBox
    |       |   +-- Citation (inline)
    |       |   +-- CopyMessage
    |       |   +-- RewriteMessage
    |       +-- MessageBoxLoading
    |       +-- SearchStatusIndicator
    |       +-- RelatedPapersPanel
    |       +-- MessageInput
    |           +-- ChatToolDropdown
    |           +-- PdfSelector
    +-- Chats (/chats) -- standalone history list
    +-- Library (/library) -- folder list + upload
    +-- Folder Detail (/library/[folderId])
    |   +-- LibraryEmbeddingSearchModal
    +-- Related Papers (/library/papers/[id]/related)
    +-- Models (/models)
    |   +-- ModelFamilyGroup
    |   +-- AddProvider
    +-- Inspect (/inspect)
    |   +-- ThreeEmbeddingViewer
    +-- Sync (/sync)
        +-- GithubProjectCard
```
