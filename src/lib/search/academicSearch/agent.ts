import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage, HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import EventEmitter from "events";
import { searchSearxng } from "@/lib/searxng";
import { classifyAcademicQuery } from "./classifier";
import { getAcademicWriterPrompt } from "@/lib/prompts/academicSearch";
import { AcademicSearchChunk } from "./types";

const ACADEMIC_ENGINES = ["arxiv", "google scholar", "pubmed"];

/**
 * Executes the full academic search pipeline:
 * 1. Classifies the query to get a standalone version + search queries
 * 2. Queries SearXNG with academic engines in parallel
 * 3. Emits the search results as sources
 * 4. Generates a streamed LLM response using the writer prompt
 */
async function executeSearch(
     emitter: EventEmitter,
     query: string,
     history: Array<[string, string]>,
     llm: BaseChatModel,
     systemInstructions: string,
): Promise<void> {
     try {
          // Step 1: classify query and generate targeted search queries
          const { standaloneQuery, searchQueries } = await classifyAcademicQuery(query, history, llm);

          // Step 2: search SearXNG in parallel for each query
          const allChunks: AcademicSearchChunk[] = [];

          await Promise.all(
               searchQueries.map(async (q) => {
                    try {
                         const { results } = await searchSearxng(q, {
                              engines: ACADEMIC_ENGINES,
                         });
                         const chunks: AcademicSearchChunk[] = results.map((r) => ({
                              content: r.content || r.title,
                              metadata: { title: r.title, url: r.url },
                         }));
                         allChunks.push(...chunks);
                    } catch (err) {
                         console.warn(`[academicSearch] SearXNG query failed for "${q}":`, err);
                    }
               }),
          );

          // Deduplicate by URL
          const seen = new Set<string>();
          const dedupedChunks = allChunks.filter(({ metadata: { url } }) => {
               if (seen.has(url)) return false;
               seen.add(url);
               return true;
          });

          // Step 3: emit sources so the client can display them
          const sources = dedupedChunks.map((chunk) => ({
               pageContent: chunk.content,
               metadata: { title: chunk.metadata.title, url: chunk.metadata.url },
          }));

          emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));

          // Step 4: build context string and stream the writer response
          const context = dedupedChunks
               .map((chunk, i) => `[${i + 1}] ${chunk.metadata.title}\n${chunk.content}\n(${chunk.metadata.url})`)
               .join("\n\n");

          const writerPrompt = getAcademicWriterPrompt(context, systemInstructions);

          const chatHistory: BaseMessage[] = history.flatMap(([role, content]): BaseMessage[] =>
               role === "human" ? [new HumanMessage(content)] : [new AIMessage(content)],
          );

          const llmStream = await llm.stream([
               new SystemMessage(writerPrompt),
               ...chatHistory,
               new HumanMessage(standaloneQuery),
          ]);

          for await (const chunk of llmStream) {
               const text = typeof chunk.content === "string" ? chunk.content : "";
               if (text) {
                    emitter.emit("data", JSON.stringify({ type: "response", data: text }));
               }
          }

          emitter.emit("end");
     } catch (err: any) {
          console.error("[academicSearch] Search failed:", err);
          emitter.emit("error", JSON.stringify({ data: err?.message ?? "Academic search failed" }));
     }
}

/**
 * Creates and returns an EventEmitter that fires search events asynchronously.
 * Mirrors the pattern used by BaseSearchAgent.searchAndAnswer.
 */
export function createAcademicSearchStream(
     query: string,
     history: Array<[string, string]>,
     llm: BaseChatModel,
     systemInstructions: string,
): EventEmitter {
     const emitter = new EventEmitter();
     // Run without blocking — the caller attaches listeners before awaiting
     setImmediate(() => executeSearch(emitter, query, history, llm, systemInstructions));
     return emitter;
}
