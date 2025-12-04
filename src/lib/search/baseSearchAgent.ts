import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { RunnableLambda, RunnableMap, RunnableSequence } from "@langchain/core/runnables";
import { BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { Document } from "@langchain/core/documents";
import { StreamEvent } from "@langchain/core/tracers/log_stream";

import eventEmitter from "events";

import formatChatHistoryAsString from "../utils/formatHistory";

export interface BaseSearchAgentConfig {
     queryGeneratorPrompt: string;
     queryGeneratorFewShots: BaseMessageLike[];
     responsePrompt: string;
}

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

                         return docs;
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
      * Formats documents into a string for the LLM context.
      * Includes similarity score if available.
      */
     protected processDocs(docs: Document[]): string {
          return docs
               .map((doc, index) => {
                    const score = doc.metadata.score !== undefined ? ` [score: ${doc.metadata.score.toFixed(3)}]` : "";
                    return `${index + 1}. ${doc.metadata.title}${score} ${doc.pageContent}`;
               })
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
          systemInstructions: string,
          searchRetrieverChainArgs: any[] = []
     ): Promise<eventEmitter> {
          const emitter = new eventEmitter();

          const answeringChain = await this.createAnsweringChain(llm, systemInstructions, searchRetrieverChainArgs);

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
