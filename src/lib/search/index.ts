export { HNSWSearch, type HNSWConfig, type SearchResult, type EmbeddingRecord } from "./HNSWSearch";
export { default } from "./HNSWSearch";
export { default as BaseSearchAgent } from "./baseSearchAgent";
export { default as CodeSearchAgent } from "./codeSearchAgent";

import type CodeSearchAgent from "./codeSearchAgent";
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
