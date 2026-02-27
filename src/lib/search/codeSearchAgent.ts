import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { Document } from "@langchain/core/documents";

import { BaseSearchAgent, BaseSearchAgentConfig, BasicChainInput, SearchRetrieverResult } from "./baseSearchAgent";
import LineOutputParser from "../outputParsers/lineOutputParser";

// HNSWSearch is loaded lazily to avoid faiss-node being bundled
import type { HNSWSearch as HNSWSearchType } from "./HNSWSearch";

import { embedQuery } from "./embedding";

// Lazy load server modules to avoid better-sqlite3 being bundled
function getModelRegistry() {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("@/server/providerRegistry").default;
}
function getConfigManager() {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("@/server/index").default;
}

// Lazy load folderRegistry to avoid circular dependencies during bundling
function getFolderRegistry() {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("@/server/folderRegistry").default;
}

// Lazy load HNSWSearch to avoid faiss-node being bundled at module load time
function getHNSWSearch(): typeof HNSWSearchType {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("./HNSWSearch").HNSWSearch;
}

export interface CodeSearchAgentConfig extends BaseSearchAgentConfig {
     maxNDocuments: number;
     activeEngines: string[];
}

class CodeSearchAgent extends BaseSearchAgent {
     declare protected config: CodeSearchAgentConfig;

     constructor(config: CodeSearchAgentConfig) {
          super(config);
          this.config = config;
     }

     /**
      * Implementation of the search retriever chain for code search.
      * The folderNames are passed via searchRetrieverChainArgs from searchAndAnswer.
      */
     protected async createSearchRetrieverChain(
          llm: BaseChatModel,
          folderNames: string[] = [],
          originalQuery: string = ""
     ): Promise<RunnableSequence<BasicChainInput, SearchRetrieverResult>> {
          (llm as unknown as ChatOpenAI).temperature = 0;

          // Capture folderNames in closure for use in the lambda
          const capturedFolderNames = folderNames;
          const capturedOriginalQuery = originalQuery;

          // Capture emitStatus for use in the lambda
          const emitStatus = this.emitStatus.bind(this);

          // Get registered folders info for status updates (lazy loaded)
          const folderRegistry = getFolderRegistry();
          const registeredFolders = folderRegistry.getFolders();

          return RunnableSequence.from([
               ChatPromptTemplate.fromMessages([
                    ["system", this.config.queryGeneratorPrompt],
                    ...this.config.queryGeneratorFewShots,
                    [
                         "user",
                         `
                         <conversation>
                         {chat_history}
                         </conversation>

                         <query>
                         {query}
                         </query>
                         `,
                    ],
               ]),
               llm,
               this.strParser,
               RunnableLambda.from(async (llmOutput: string): Promise<SearchRetrieverResult> => {
                    // Emit initial status
                    emitStatus({
                         stage: "analyzing",
                         message: "Analyzing your query...",
                         details: {
                              folderCount: registeredFolders.length,
                              folderNames: registeredFolders.map((f: { name: string }) => f.name),
                         },
                    });

                    const questionOutputParser = new LineOutputParser({
                         key: "question",
                    });

                    let question = (await questionOutputParser.parse(llmOutput)) ?? llmOutput;

                    if (question === "not_needed") {
                         emitStatus({
                              stage: "generating",
                              message: "No search needed for this query",
                         });
                         return { query: "", docs: [] };
                    }

                    question = question.replace(/<think>.*?<\/think>/g, "");

                    // Emit status: searching embeddings
                    emitStatus({
                         stage: "searching",
                         message: `Searching embeddings in ${capturedFolderNames.length} folder(s)...`,
                         details: {
                              folderCount: capturedFolderNames.length,
                              folderNames: capturedFolderNames,
                         },
                    });

                    // Initialize HNSW search from app config (lazy loaded)
                    const HNSWSearch = getHNSWSearch();
                    const hnswSearch = HNSWSearch.fromConfig();

                    // Add folders to the index
                    const indexedCount = await hnswSearch.addFolders(capturedFolderNames);

                    // Emit status: embedding query
                    emitStatus({
                         stage: "embedding",
                         message: `Indexed ${indexedCount} embeddings. Generating query embedding...`,
                         details: {
                              embeddingCount: indexedCount,
                         },
                    });

                    let results: any[] = [];

                    // 1. Try Raw Query First
                    if (capturedOriginalQuery && capturedOriginalQuery.trim().length > 0) {
                         const rawEmbedding = await embedQuery(capturedOriginalQuery);
                         results = await hnswSearch.searchWithThreshold(
                              rawEmbedding,
                              this.config.maxNDocuments
                         );
                    }

                    // 2. If no results, try Rephrased Query (if different)
                    if (results.length === 0 && question !== capturedOriginalQuery) {
                         if (capturedOriginalQuery) {
                              emitStatus({
                                   stage: "retrieving",
                                   message: "No results with raw query. Trying rephrased query...",
                              });
                         }

                         const rephrasedEmbedding = await embedQuery(question);
                         results = await hnswSearch.searchWithThreshold(
                              rephrasedEmbedding,
                              this.config.maxNDocuments
                         );
                    }

                    // If still no results, return an informative document
                    if (results.length === 0) {
                         emitStatus({
                              stage: "generating",
                              message: "No matching documents found in embeddings",
                              details: { resultCount: 0 },
                         });

                         return {
                              query: question,
                              docs: [
                                   new Document({
                                        pageContent:
                                             "No relevant documents found with the current similarity threshold. Please try lowering the threshold in settings or rephrasing your query.",
                                        metadata: {
                                             type: "system_message",
                                             title: "No Results Found",
                                             score: 0,
                                        },
                                   }),
                              ],
                         };
                    }

                    // Emit status: results found
                    emitStatus({
                         stage: "generating",
                         message: `Found ${results.length} relevant document(s)`,
                         details: { resultCount: results.length },
                    });

                    const documents = results.map(
                         (result) =>
                              new Document({
                                   pageContent: result.content ?? "",
                                   metadata: {
                                        type: "document",
                                        title:
                                             (result.metadata.symbolName as string) ||
                                             (result.metadata.nodeType as string) ||
                                             result.relativePath,
                                        url: `file://${result.filePath}`,
                                        relativePath: result.relativePath,
                                        folderName: result.folderName,
                                        score: result.score,
                                        language: result.metadata.language,
                                        startLine: result.metadata.startLine,
                                        endLine: result.metadata.endLine,
                                   },
                              })
                    );

                    return { query: question, docs: documents };
               }),
          ]);
     }
}

export default CodeSearchAgent;
