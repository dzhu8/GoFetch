import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Embeddings } from "@langchain/core/embeddings";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { RunnableLambda, RunnableMap, RunnableSequence } from "@langchain/core/runnables";
import { BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { Document } from "@langchain/core/documents";
import { StreamEvent } from "@langchain/core/tracers/log_stream";

import path from "node:path";
import fs from "node:fs";
import eventEmitter from "events";

import computeSimilarity from "../utils/computeSimilarity";
import formatChatHistoryAsString from "../utils/formatHistory";

export interface BaseSearchAgentConfig {
     rerank: boolean;
     rerankThreshold: number;
     queryGeneratorPrompt: string;
     queryGeneratorFewShots: BaseMessageLike[];
     responsePrompt: string;
     /** If true, skip rerankDocs (useful when search retriever already ranks results) */
     skipRerank?: boolean;
}

export type OptimizationMode = "speed" | "balanced" | "quality";

export type BasicChainInput = {
     chat_history: BaseMessage[] | string;
     query: string;
};

export interface SearchRetrieverResult {
     query: string;
     docs: Document[];
}

export abstract class BaseSearchAgent {
     protected config: BaseSearchAgentConfig;
     protected strParser = new StringOutputParser();

     constructor(config: BaseSearchAgentConfig) {
          this.config = config;
     }

     /**
      * Abstract method that each specific agent must implement.
      * This defines how the agent retrieves and processes search results.
      */
     protected abstract createSearchRetrieverChain(
          llm: BaseChatModel,
          ...args: any[]
     ): Promise<RunnableSequence<BasicChainInput, SearchRetrieverResult>>;

     /**
      * Creates the answering chain that processes retrieved documents and generates responses.
      */
     protected async createAnsweringChain(
          llm: BaseChatModel,
          fileIds: string[],
          embeddings: Embeddings,
          optimizationMode: OptimizationMode,
          systemInstructions: string,
          searchRetrieverChainArgs: any[] = []
     ) {
          return RunnableSequence.from([
               RunnableMap.from({
                    systemInstructions: () => systemInstructions,
                    query: (input: BasicChainInput) => input.query,
                    chat_history: (input: BasicChainInput) => input.chat_history,
                    date: () => new Date().toISOString(),
                    context: RunnableLambda.from(async (input: BasicChainInput) => {
                         const processedHistory =
                              typeof input.chat_history === "string"
                                   ? input.chat_history
                                   : formatChatHistoryAsString(input.chat_history);

                         const searchRetrieverChain = await this.createSearchRetrieverChain(
                              llm,
                              ...searchRetrieverChainArgs
                         );

                         const searchRetrieverResult = await searchRetrieverChain.invoke({
                              chat_history: processedHistory,
                              query: input.query,
                         });

                         const query = searchRetrieverResult.query;
                         const docs = searchRetrieverResult.docs;

                         // Skip reranking if configured (e.g., when search retriever already ranks results)
                         if (this.config.skipRerank) {
                              return docs;
                         }

                         const sortedDocs = await this.rerankDocs(
                              query,
                              docs ?? [],
                              fileIds,
                              embeddings,
                              optimizationMode
                         );

                         return sortedDocs;
                    })
                         .withConfig({
                              runName: "FinalSourceRetriever",
                         })
                         .pipe(this.processDocs),
               }),
               ChatPromptTemplate.fromMessages([
                    ["system", this.config.responsePrompt],
                    new MessagesPlaceholder("chat_history"),
                    ["user", "{query}"],
               ]),
               llm,
               this.strParser,
          ]).withConfig({
               runName: "FinalResponseGenerator",
          });
     }

     /**
      * Reranks documents based on similarity to the query.
      */
     protected async rerankDocs(
          query: string,
          docs: Document[],
          fileIds: string[],
          embeddings: Embeddings,
          optimizationMode: OptimizationMode
     ): Promise<Document[]> {
          if (docs.length === 0 && fileIds.length === 0) {
               return docs;
          }

          const filesData = fileIds
               .map((file) => {
                    const filePath = path.join(process.cwd(), "uploads", file);

                    const contentPath = filePath + "-extracted.json";
                    const embeddingsPath = filePath + "-embeddings.json";

                    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
                    const embeddingsData = JSON.parse(fs.readFileSync(embeddingsPath, "utf8"));

                    const fileSimilaritySearchObject = content.contents.map((c: string, i: number) => {
                         return {
                              fileName: content.title,
                              content: c,
                              embeddings: embeddingsData.embeddings[i],
                         };
                    });

                    return fileSimilaritySearchObject;
               })
               .flat();

          if (query.toLocaleLowerCase() === "summarize") {
               return docs.slice(0, 15);
          }

          const docsWithContent = docs.filter((doc) => doc.pageContent && doc.pageContent.length > 0);

          if (optimizationMode === "speed" || this.config.rerank === false) {
               if (filesData.length > 0) {
                    const [queryEmbedding] = await Promise.all([embeddings.embedQuery(query)]);

                    const fileDocs = filesData.map((fileData) => {
                         return new Document({
                              pageContent: fileData.content,
                              metadata: {
                                   title: fileData.fileName,
                                   url: `File`,
                              },
                         });
                    });

                    const similarity = filesData.map((fileData, i) => {
                         const sim = computeSimilarity(queryEmbedding, fileData.embeddings);

                         return {
                              index: i,
                              similarity: sim,
                         };
                    });

                    let sortedDocs = similarity
                         .filter((sim) => sim.similarity > (this.config.rerankThreshold ?? 0.3))
                         .sort((a, b) => b.similarity - a.similarity)
                         .slice(0, 15)
                         .map((sim) => fileDocs[sim.index]);

                    sortedDocs = docsWithContent.length > 0 ? sortedDocs.slice(0, 8) : sortedDocs;

                    return [...sortedDocs, ...docsWithContent.slice(0, 15 - sortedDocs.length)];
               } else {
                    return docsWithContent.slice(0, 15);
               }
          } else if (optimizationMode === "balanced") {
               const [docEmbeddings, queryEmbedding] = await Promise.all([
                    embeddings.embedDocuments(docsWithContent.map((doc) => doc.pageContent)),
                    embeddings.embedQuery(query),
               ]);

               docsWithContent.push(
                    ...filesData.map((fileData) => {
                         return new Document({
                              pageContent: fileData.content,
                              metadata: {
                                   title: fileData.fileName,
                                   url: `File`,
                              },
                         });
                    })
               );

               docEmbeddings.push(...filesData.map((fileData) => fileData.embeddings));

               const similarity = docEmbeddings.map((docEmbedding, i) => {
                    const sim = computeSimilarity(queryEmbedding, docEmbedding);

                    return {
                         index: i,
                         similarity: sim,
                    };
               });

               const sortedDocs = similarity
                    .filter((sim) => sim.similarity > (this.config.rerankThreshold ?? 0.3))
                    .sort((a, b) => b.similarity - a.similarity)
                    .slice(0, 15)
                    .map((sim) => docsWithContent[sim.index]);

               return sortedDocs;
          }

          return [];
     }

     /**
      * Formats documents into a string for the LLM context.
      */
     protected processDocs(docs: Document[]): string {
          return docs
               .map((_, index) => `${index + 1}. ${docs[index].metadata.title} ${docs[index].pageContent}`)
               .join("\n");
     }

     /**
      * Handles the streaming of events from the chain.
      */
     protected async handleStream(stream: AsyncGenerator<StreamEvent, any, any>, emitter: eventEmitter): Promise<void> {
          for await (const event of stream) {
               if (event.event === "on_chain_end" && event.name === "FinalSourceRetriever") {
                    emitter.emit("data", JSON.stringify({ type: "sources", data: event.data.output }));
               }
               if (event.event === "on_chain_stream" && event.name === "FinalResponseGenerator") {
                    emitter.emit("data", JSON.stringify({ type: "response", data: event.data.chunk }));
               }
               if (event.event === "on_chain_end" && event.name === "FinalResponseGenerator") {
                    emitter.emit("end");
               }
          }
     }

     /**
      * Main entry point for searching and answering.
      * Can be overridden by subclasses if needed.
      */
     async searchAndAnswer(
          message: string,
          history: BaseMessage[],
          llm: BaseChatModel,
          embeddings: Embeddings,
          optimizationMode: OptimizationMode,
          fileIds: string[],
          systemInstructions: string,
          searchRetrieverChainArgs: any[] = []
     ): Promise<eventEmitter> {
          const emitter = new eventEmitter();

          const answeringChain = await this.createAnsweringChain(
               llm,
               fileIds,
               embeddings,
               optimizationMode,
               systemInstructions,
               searchRetrieverChainArgs
          );

          const stream = answeringChain.streamEvents(
               {
                    chat_history: history,
                    query: message,
               },
               {
                    version: "v1",
               }
          );

          this.handleStream(stream, emitter);

          return emitter;
     }
}

export default BaseSearchAgent;
