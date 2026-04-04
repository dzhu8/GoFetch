# Agent Instructions

This repository contains complex logic for chat handling, document processing, and search. To ensure successful modifications, agents should follow these guidelines.

## Codebase Reference

Before making any changes to the core logic (especially in `src/lib`), **always consult [docs/FEATURES.md](docs/FEATURES.md)**. This file provides a detailed breakdown of the system architecture, data flows, and module responsibilities.

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
