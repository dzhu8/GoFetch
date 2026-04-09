import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import EventEmitter from "events";
import { searchSearxng } from "@/lib/searxng";
import { classifyWebQuery, messagesToTuples } from "./classifier";
import { getWebWriterPrompt } from "@/lib/prompts/webSearch";
import { formatResultsForPrompt } from "@/lib/search";
import { WebSearchChunk } from "./types";

const WEB_CATEGORIES = ["general"];

export interface WebSearchSource {
     pageContent: string;
     metadata: { title: string; url: string };
}

export interface WebSearchPreprocessResult {
     standaloneQuery: string;
     searchResults: WebSearchChunk[];
     sources: WebSearchSource[];
}

/**
 * Preprocessing-only variant of WebSearchAgent.
 * Classifies the query, runs SearXNG web search, deduplicates, and caps to 10 results.
 * No LLM response generation — returns structured context for external consumption (MCP).
 *
 * When `llm` is provided, the classifier reformulates the query for better search results.
 * When omitted (e.g. Copilot bridge), the raw user query is used directly.
 */
export async function preprocessWebSearch(
     query: string,
     history: Array<[string, string]>,
     llm?: BaseChatModel,
): Promise<WebSearchPreprocessResult> {
     let standaloneQuery: string;
     let searchQueries: string[];

     if (llm) {
          ({ standaloneQuery, searchQueries } = await classifyWebQuery(query, history, llm));
     } else {
          standaloneQuery = query;
          searchQueries = [query];
     }

     const allChunks: WebSearchChunk[] = [];

     await Promise.all(
          searchQueries.map(async (q) => {
               try {
                    const { results } = await searchSearxng(q, {
                         categories: WEB_CATEGORIES,
                    });
                    const chunks: WebSearchChunk[] = results.map((r) => ({
                         content: r.content || r.title,
                         metadata: { title: r.title, url: r.url },
                    }));
                    allChunks.push(...chunks);
               } catch (err) {
                    console.warn(`[webSearch] SearXNG query failed for "${q}":`, err);
               }
          }),
     );

     const seen = new Set<string>();
     let dedupedChunks = allChunks.filter(({ metadata: { url } }) => {
          if (seen.has(url)) return false;
          seen.add(url);
          return true;
     });

     dedupedChunks = dedupedChunks.slice(0, 10);

     const sources: WebSearchSource[] = dedupedChunks.map((chunk) => ({
          pageContent: chunk.content,
          metadata: { title: chunk.metadata.title, url: chunk.metadata.url },
     }));

     return { standaloneQuery, searchResults: dedupedChunks, sources };
}

/**
 * Executes the full web search pipeline:
 * 1. Classifies the query to get a standalone version + search queries
 * 2. Queries SearXNG with general engines in parallel
 * 3. Deduplicates and caps results
 * 4. Emits the search results as sources
 * 5. Generates a streamed LLM response using the writer prompt
 */
async function executeSearch(
     emitter: EventEmitter,
     query: string,
     history: Array<[string, string]>,
     llm: BaseChatModel,
     systemInstructions: string,
): Promise<void> {
     try {
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "analyzing", message: "Analyzing query..." } }));
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "searching", message: "Searching the web..." } }));

          const { standaloneQuery, searchResults, sources } = await preprocessWebSearch(query, history, llm);

          emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));

          // Build context string and stream the writer response
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "generating", message: "Generating answer..." } }));
          const context = formatResultsForPrompt(searchResults, "Content");

          const writerPrompt = getWebWriterPrompt(context, systemInstructions);

          const chatHistory: BaseMessage[] = history.flatMap(([role, content]): BaseMessage[] =>
               role === "human" ? [new HumanMessage(content)] : [new AIMessage(content)],
          );

          const llmStream = await llm.stream([
               new SystemMessage(writerPrompt),
               ...chatHistory,
               new HumanMessage(standaloneQuery),
          ]);

          let outputStarted = false;
          let buffer = "";
          for await (const chunk of llmStream) {
               const text = typeof chunk.content === "string" ? chunk.content : "";
               if (!text) continue;

               if (outputStarted) {
                    buffer += text;
                    const endIdx = buffer.indexOf("</output>");
                    if (endIdx !== -1) {
                         const finalText = buffer.slice(0, endIdx);
                         if (finalText) {
                              emitter.emit("data", JSON.stringify({ type: "response", data: finalText }));
                         }
                         break;
                    }
                    const safe = buffer.length - "</output>".length;
                    if (safe > 0) {
                         emitter.emit("data", JSON.stringify({ type: "response", data: buffer.slice(0, safe) }));
                         buffer = buffer.slice(safe);
                    }
               } else {
                    buffer += text;
                    const startIdx = buffer.indexOf("<output>");
                    if (startIdx !== -1) {
                         outputStarted = true;
                         buffer = buffer.slice(startIdx + "<output>".length);
                    }
               }
          }

          emitter.emit("end");
     } catch (err: any) {
          console.error("[webSearch] Search failed:", err);
          emitter.emit("error", JSON.stringify({ data: err?.message ?? "Web search failed" }));
     }
}

/**
 * Stand-alone stream factory used by the chat route's default focus mode.
 * Accepts BaseMessage[] history (as used by the chat route) and converts internally.
 */
export class WebSearchAgent {
     async searchAndAnswer(
          message: string,
          history: BaseMessage[],
          llm: BaseChatModel,
          systemInstructions: string,
          _searchRetrieverChainArgs?: any[],
     ): Promise<EventEmitter> {
          const emitter = new EventEmitter();
          const historyTuples = messagesToTuples(history);
          setImmediate(() => executeSearch(emitter, message, historyTuples, llm, systemInstructions));
          return emitter;
     }
}

/**
 * Creates and returns an EventEmitter that fires search events asynchronously.
 * Accepts history as [role, content] tuples (used by the academic-search route shape if ever needed).
 */
export function createWebSearchStream(
     query: string,
     history: Array<[string, string]>,
     llm: BaseChatModel,
     systemInstructions: string,
): EventEmitter {
     const emitter = new EventEmitter();
     setImmediate(() => executeSearch(emitter, query, history, llm, systemInstructions));
     return emitter;
}
