// Only export types to avoid loading native modules (faiss-node, better-sqlite3) at bundle time
// Use getSearchHandlers() or getHNSWSearch() for the actual classes
export type { HNSWConfig, SearchResult, EmbeddingRecord } from "./HNSWSearch";
export type { SearchStatus, SearchRetrieverResult, BasicChainInput, BaseSearchAgentConfig } from "./baseSearchAgent";

// Re-export types only - actual classes must be accessed via lazy loaders
export type { default as BaseSearchAgent } from "./baseSearchAgent";
export type { default as CodeSearchAgent } from "./codeSearchAgent";

import type CodeSearchAgent from "./codeSearchAgent";
import type { HNSWSearch as HNSWSearchType } from "./HNSWSearch";
import {
     codeSearchRetrieverPrompt,
     codeSearchRetrieverFewShots,
     codeSearchResponsePrompt,
} from "../prompts/codeSearch";

// Lazy-loaded search handlers to avoid instantiating HNSWSearch at module load time
// This prevents faiss-node from being required during Next.js bundling
let _searchHandlers: Record<string, CodeSearchAgent> | null = null;

export function getSearchHandlers(): Record<string, CodeSearchAgent> {
     if (!_searchHandlers) {
          // Dynamic import to ensure this only runs server-side at runtime
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { default: CodeSearchAgentClass } = require("./codeSearchAgent");
          _searchHandlers = {
               code: new CodeSearchAgentClass({
                    queryGeneratorPrompt: codeSearchRetrieverPrompt,
                    queryGeneratorFewShots: codeSearchRetrieverFewShots,
                    responsePrompt: codeSearchResponsePrompt,
                    maxNDocuments: 15,
                    activeEngines: [],
               }),
          };
     }
     return _searchHandlers;
}

/**
 * Lazy loader for HNSWSearch class.
 * Use this instead of importing HNSWSearch directly to avoid faiss-node being loaded at bundle time.
 */
export function getHNSWSearch(): typeof HNSWSearchType {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("./HNSWSearch").HNSWSearch;
}
