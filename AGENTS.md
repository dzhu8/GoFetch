# Agent Instructions

This repository contains complex logic for chat handling, document processing, and search. To ensure successful modifications, agents should follow these guidelines.

## Codebase Reference

Before making any changes to the core logic (especially in `src/lib`), **always consult [docs/FEATURES.md](docs/FEATURES.md)**. This file provides a detailed breakdown of the system architecture, data flows, and module responsibilities. After making changes to the core logic, **update [docs/FEATURES.md](docs/FEATURES.md)** with the description of your new changes.

For chat-specific work (components, routes, agents, streaming), **also consult [docs/CHAT.md](docs/CHAT.md)**. It maps every file touched by chat features end-to-end: page routes, API handlers, React components, agent pipeline, prompt templates, DB schema, and MCP tools.

### FEATURES.md Summary

- **`chat/`**: Manages conversation state, message handling, and the core message pipeline (streaming, citations, suggestions).
- **`chunk/`**: Logic for splitting documents into searchable chunks.
- **`citations/`**: Utilities for handling and formatting source citations.
- **`config/`**: System configuration and provider management.
- **`embed/`**: Vector embedding logic for documents and queries.
- **`models/`**: Model preference resolution and provider interfaces.
- **`output/`**: Handling of specialized outputs like suggestions and follow-up actions.
- **`outputParsers/`**: Parsers for converting LLM output into structured data.
- **`prompts/`**: System prompt templates and management.
- **`relatedPapers/`**: Logic for fetching and resolving academic paper links.
- **`search/`**: Core search implementation, including academic and library search.
- **`utils/`**: Shared utility functions and standalone helpers.

## General Principles

1. **Check Documentation First**: Use `FEATURES.md` to understand how a component fits into the larger system before editing.
2. **Respect Streaming**: Many API routes use streaming JSON. Ensure edits to `chat/` or API handlers maintain this protocol.
3. **Type Safety**: Maintain strict TypeScript typing across `src/lib` and `src/types`.
4. **Update Interface Docs**: When modifying or adding interface components (in `src/components/`, `src/app/`, or any UI-facing code), **update [docs/INTERFACE.md](docs/INTERFACE.md)** with the description of your changes. This file maps `src/lib` feature modules to the UI components that surface them.
5. **Update Testing Docs**: Certain features & elements will occasionally be introduced for testing purposes, and should be noted so they can be found for easy removal later once the testing phase has completed. If a task mentions "backwards compatiblity" or "testing", **update [docs/temporary/TESTING.md](docs/temporary/TESTING.md)** with the description of exactly which components are meant for testing or for integrating with tests. 
6. **Update MCP Docs**: When adding or modifying MCP server tools, preprocessing variants, or any logic intended for external agent consumption, **update [docs/MCP.md](docs/MCP.md)** with the description of your changes.
7. **Update Chat Docs**: When modifying any part of the chat pipeline -- API routes (`/api/chat`, `/api/academic-search`), chat components (`src/components/Chat*.tsx`, `MessageBox.tsx`, `MessageInput.tsx`, etc.), message action components (`src/components/messageActions/`), the chat context provider (`src/lib/chat/Chat.tsx`), agent selection logic, or streaming protocol -- **update [docs/CHAT.md](docs/CHAT.md)** with the description of your changes. This file traces the full data flow from user input through agent execution to UI rendering.
