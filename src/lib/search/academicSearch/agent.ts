import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage, HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import EventEmitter from "events";
import { searchSearxng } from "@/lib/searxng";
import { classifyAcademicQuery } from "./classifier";
import { filterRelevantChunks } from "./filter";
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
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "analyzing", message: "Analyzing query..." } }));
          const { standaloneQuery, searchQueries } = await classifyAcademicQuery(query, history, llm);

          // Step 2: search SearXNG in parallel for each query
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "searching", message: "Querying academic databases..." } }));
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
          let dedupedChunks = allChunks.filter(({ metadata: { url } }) => {
               if (seen.has(url)) return false;
               seen.add(url);
               return true;
          });

          // Limit initial search results to avoid context explosion in the filter step
          dedupedChunks = dedupedChunks.slice(0, 45);

          // Step 3: use the LLM as a judge to filter out irrelevant sources
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "analyzing", message: "Filtering relevant sources..." } }));
          let filteredChunks = await filterRelevantChunks(standaloneQuery, dedupedChunks, llm);

          // If filtering accidentally dropped everything but we originally had results, fallback entirely
          if (filteredChunks.length === 0 && dedupedChunks.length > 0) {
              console.warn("[academicSearch] Filter discarded all chunks. Falling back to top 3.");
              filteredChunks = dedupedChunks.slice(0, 3);
          }

          // Limit to a maximum of 15 relevant sources to avoid context explosion and citation confusion
          filteredChunks = filteredChunks.slice(0, 15);

          // Step 4: emit sources so the client can display them
          const sources = filteredChunks.map((chunk) => ({
               pageContent: chunk.content,
               metadata: { title: chunk.metadata.title, url: chunk.metadata.url },
          }));

          emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));

          // Step 5: build context string and stream the writer response
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "generating", message: "Synthesizing answer..." } }));
          const context = filteredChunks
               .map((chunk, i) => `Source [${i + 1}]:\nTitle: ${chunk.metadata.title}\nURL: ${chunk.metadata.url}\nAbstract: ${chunk.content}`)
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
