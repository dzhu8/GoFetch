export { HNSWSearch, type HNSWConfig, type SearchResult, type EmbeddingRecord } from "./HNSWSearch";
export { default } from "./HNSWSearch";
export { default as BaseSearchAgent } from "./baseSearchAgent";
export { default as CodeSearchAgent } from "./codeSearchAgent";

import CodeSearchAgent from "./codeSearchAgent";
import {
     codeSearchRetrieverPrompt,
     codeSearchRetrieverFewShots,
     codeSearchResponsePrompt,
} from "../prompts/codeSearch";

export const searchHandlers: Record<string, CodeSearchAgent> = {
     code: new CodeSearchAgent({
          queryGeneratorPrompt: codeSearchRetrieverPrompt,
          queryGeneratorFewShots: codeSearchRetrieverFewShots,
          responsePrompt: codeSearchResponsePrompt,
          maxNDocuments: 15,
          activeEngines: [],
     }),
};
