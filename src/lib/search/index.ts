// Only export types to avoid loading native modules (faiss-node, better-sqlite3) at bundle time
// Use getSearchHandlers() or getHNSWSearch() for the actual classes
export type { HNSWConfig, SearchResult, EmbeddingRecord } from "./HNSWSearch";
export type { SearchStatus, SearchRetrieverResult, BasicChainInput, BaseSearchAgentConfig } from "./baseSearchAgent";

// Re-export types only - actual classes must be accessed via lazy loaders
export type { default as BaseSearchAgent } from "./baseSearchAgent";

import type { HNSWSearch as HNSWSearchType } from "./HNSWSearch";

/** Minimal interface required by the chat route. */
export interface SearchAgentLike {
     searchAndAnswer(
          message: string,
          history: import("@langchain/core/messages").BaseMessage[],
          llm: import("@langchain/core/language_models/chat_models").BaseChatModel,
          systemInstructions: string,
          searchRetrieverChainArgs?: any[],
     ): Promise<import("events").EventEmitter>;
}

// Lazy-loaded search handlers
let _searchHandlers: Record<string, SearchAgentLike> | null = null;

export function getSearchHandlers(): Record<string, SearchAgentLike> {
     if (!_searchHandlers) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { WebSearchAgent: WebSearchAgentClass } = require("./webSearch/agent");
          const webSearchAgent = new WebSearchAgentClass();
          _searchHandlers = {
               default: webSearchAgent,
               // "code" is kept as an alias so existing clients sending focusMode:"code" still work
               code: webSearchAgent,
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
