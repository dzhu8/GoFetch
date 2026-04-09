import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage, HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import EventEmitter from "events";
import { searchSearxng } from "@/lib/searxng";
import { classifyAcademicQuery } from "./classifier";
import { filterRelevantChunks } from "./filter";
import { getAcademicWriterPrompt } from "@/lib/prompts/academicSearch";
import { formatResultsForPrompt } from "@/lib/search";
import { AcademicSearchChunk } from "./types";

const ACADEMIC_ENGINES = ["arxiv", "google scholar", "pubmed"];

const REPUTABLE_PUBLISHERS = [
     "nature.com",
     "science.org",
     "sciencedirect.com",
     "ieeexplore.ieee.org",
     "pnas.org",
     "nejm.org",
     "thelancet.com",
     "cell.com",
     "jamanetwork.com",
     "arxiv.org",
     "springer.com",
     "wiley.com"
];

function isReputable(url: string): boolean {
     const normalizedUrl = url.toLowerCase();
     return REPUTABLE_PUBLISHERS.some((publisher) => normalizedUrl.includes(publisher));
}

export interface AcademicSearchSource {
     pageContent: string;
     metadata: { title: string; url: string };
}

export interface AcademicSearchPreprocessResult {
     standaloneQuery: string;
     filteredResults: AcademicSearchChunk[];
     sources: AcademicSearchSource[];
}

/**
 * Preprocessing-only variant of AcademicSearchAgent.
 * Classifies the query, runs SearXNG academic search (arxiv, google scholar, pubmed),
 * deduplicates, and caps results. Skips the LLM-as-judge filtering step — returns all
 * deduplicated results for the external agent to judge relevance itself.
 * No LLM response generation — returns structured context for external consumption (MCP).
 *
 * When `llm` is provided, the classifier reformulates the query for better search results.
 * When omitted (e.g. Copilot bridge), the raw user query is used directly.
 */
export async function preprocessAcademicSearch(
     query: string,
     history: Array<[string, string]>,
     llm?: BaseChatModel,
): Promise<AcademicSearchPreprocessResult> {
     let standaloneQuery: string;
     let searchQueries: string[];

     if (llm) {
          ({ standaloneQuery, searchQueries } = await classifyAcademicQuery(query, history, llm));
     } else {
          standaloneQuery = query;
          searchQueries = [query];
     }

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

     const seen = new Set<string>();
     let dedupedChunks = allChunks.filter(({ metadata: { url } }) => {
          if (seen.has(url)) return false;
          seen.add(url);
          return true;
     });

     dedupedChunks = dedupedChunks.slice(0, 45);

     // Prioritize reputable publishers
     dedupedChunks.sort((a, b) => {
          const aReputable = isReputable(a.metadata.url);
          const bReputable = isReputable(b.metadata.url);
          if (aReputable && !bReputable) return -1;
          if (!aReputable && bReputable) return 1;
          return 0;
     });

     const sources: AcademicSearchSource[] = dedupedChunks.map((chunk) => ({
          pageContent: chunk.content,
          metadata: { title: chunk.metadata.title, url: chunk.metadata.url },
     }));

     return { standaloneQuery, filteredResults: dedupedChunks, sources };
}

/**
 * Executes the full academic search pipeline:
 * 1. Classifies the query to get a standalone version + search queries
 * 2. Queries SearXNG with academic engines in parallel
 * 3. LLM-as-judge filters irrelevant sources
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
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "searching", message: "Querying academic databases..." } }));

          const { standaloneQuery, filteredResults: dedupedChunks } = await preprocessAcademicSearch(query, history, llm);

          // Use the LLM as a judge to filter out irrelevant sources
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "analyzing", message: "Filtering relevant sources..." } }));
          let filteredChunks = await filterRelevantChunks(standaloneQuery, dedupedChunks, llm);

          // If filtering accidentally dropped everything but we originally had results, fallback entirely
          if (filteredChunks.length === 0 && dedupedChunks.length > 0) {
              console.warn("[academicSearch] Filter discarded all chunks. Falling back to top 3.");
              filteredChunks = dedupedChunks.slice(0, 3);
          }

          // Limit to a maximum of 15 relevant sources to avoid context explosion and citation confusion
          filteredChunks = filteredChunks.slice(0, 15);

          // Prioritize reputable publishers (already sorted in preprocess, re-sort after filtering)
          filteredChunks.sort((a, b) => {
               const aReputable = isReputable(a.metadata.url);
               const bReputable = isReputable(b.metadata.url);
               if (aReputable && !bReputable) return -1;
               if (!aReputable && bReputable) return 1;
               return 0;
          });

          // Emit sources so the client can display them
          const sources = filteredChunks.map((chunk) => ({
               pageContent: chunk.content,
               metadata: { title: chunk.metadata.title, url: chunk.metadata.url },
          }));

          emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));

          // Build context string and stream the writer response
          emitter.emit("data", JSON.stringify({ type: "status", data: { stage: "generating", message: "Synthesizing answer..." } }));
          const context = formatResultsForPrompt(filteredChunks, "Abstract");

          const writerPrompt = getAcademicWriterPrompt(context, systemInstructions);

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
