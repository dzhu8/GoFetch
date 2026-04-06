import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import EventEmitter from "events";
import db from "@/server/db";
import { paperChunks, paperChunkEmbeddings, papers } from "@/server/db/schema";
import { eq, inArray } from "drizzle-orm";
import computeSimilarity from "@/lib/utils/computeSimilarity";
import { embedQuery } from "@/lib/search/embedding";
import configManager from "@/server/index";

interface RankedChunk {
     content: string;
     sectionType: string;
     paperTitle: string;
     score: number;
}

function bufferToVector(buf: Buffer): number[] {
     const floatView = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
     return Array.from(floatView);
}

function buildContextString(chunks: RankedChunk[]): string {
     return chunks
          .map(
               (chunk, i) =>
                    `[${i + 1}] (Section: ${chunk.sectionType}, Paper: "${chunk.paperTitle}") ${chunk.content}`
          )
          .join("\n\n");
}

function getPdfSystemPrompt(context: string, systemInstructions: string): string {
     return `You are answering questions using ONLY the provided PDF excerpts as context. If none of the provided excerpts are relevant to the user's question, clearly state: "The provided PDF(s) do not appear to contain information relevant to this question." Do not fabricate or infer information beyond what is explicitly present in the excerpts.

### Citation Requirements
- Use inline citations like [1], [2], etc. immediately after the claim they support, corresponding to the numbered excerpts below.
- Example: "The results showed a significant improvement [1]."
- DO NOT create a bibliography or reference list at the end.
- ONLY cite excerpts provided in the <pdf_context> block below.

### Formatting
- Start directly with the answer — do not include a top-level title.
- Use Markdown for clarity (bold, headings, bullet points).

${systemInstructions ? `### User Instructions\n${systemInstructions}\n` : ""}

<pdf_context>
${context}
</pdf_context>

Current date (UTC): ${new Date().toISOString()}
`;
}

function messagesToTuples(history: BaseMessage[]): Array<[string, string]> {
     return history.map((msg) => {
          const role = msg._getType() === "human" ? "human" : "assistant";
          return [role, typeof msg.content === "string" ? msg.content : ""];
     });
}

/**
 * Retrieves chunks for the given paper IDs, ranks by cosine similarity
 * against the query embedding, and streams an LLM response.
 */
async function executeSearch(
     emitter: EventEmitter,
     query: string,
     history: Array<[string, string]>,
     llm: BaseChatModel,
     systemInstructions: string,
     paperIds: number[]
): Promise<void> {
     try {
          // Step 1: Embed the query
          emitter.emit(
               "data",
               JSON.stringify({
                    type: "status",
                    data: { stage: "embedding", message: "Embedding query..." },
               })
          );
          const queryVector = await embedQuery(query);

          // Step 2: Fetch chunks + embeddings for the given papers
          emitter.emit(
               "data",
               JSON.stringify({
                    type: "status",
                    data: { stage: "retrieving", message: "Retrieving PDF chunks..." },
               })
          );

          const chunks = db
               .select({
                    chunkId: paperChunks.id,
                    content: paperChunks.content,
                    sectionType: paperChunks.sectionType,
                    paperId: paperChunks.paperId,
                    embedding: paperChunks.embedding,
               })
               .from(paperChunks)
               .where(inArray(paperChunks.paperId, paperIds))
               .all();

          // Build a map of paper titles
          const paperRows = db
               .select({ id: papers.id, title: papers.title, fileName: papers.fileName })
               .from(papers)
               .where(inArray(papers.id, paperIds))
               .all();

          const paperTitleMap = new Map<number, string>();
          for (const p of paperRows) {
               paperTitleMap.set(p.id, p.title || p.fileName);
          }

          // Also try to load per-model embeddings from paperChunkEmbeddings
          const chunkIds = chunks.map((c) => c.chunkId);
          const perModelEmbeddings =
               chunkIds.length > 0
                    ? db
                           .select({
                                chunkId: paperChunkEmbeddings.chunkId,
                                embedding: paperChunkEmbeddings.embedding,
                           })
                           .from(paperChunkEmbeddings)
                           .where(inArray(paperChunkEmbeddings.chunkId, chunkIds))
                           .all()
                    : [];

          const perModelMap = new Map<number, Buffer>();
          for (const row of perModelEmbeddings) {
               if (row.embedding) {
                    perModelMap.set(row.chunkId, row.embedding as Buffer);
               }
          }

          // Step 3: Rank chunks by cosine similarity
          const scored: RankedChunk[] = [];
          for (const chunk of chunks) {
               // Prefer per-model embedding, fall back to legacy embedding on the chunk itself
               const embBuf = perModelMap.get(chunk.chunkId) ?? (chunk.embedding as Buffer | null);
               if (!embBuf) continue;

               const chunkVector = bufferToVector(embBuf);
               if (chunkVector.length !== queryVector.length) continue;

               const score = computeSimilarity(queryVector, chunkVector);
               scored.push({
                    content: chunk.content,
                    sectionType: chunk.sectionType,
                    paperTitle: paperTitleMap.get(chunk.paperId) ?? "Unknown",
                    score,
               });
          }

          scored.sort((a, b) => b.score - a.score);
          const scoreThreshold: number = configManager.getConfig("preferences.librarySearchScoreThreshold", 0.3);
          const topK: number = configManager.getConfig("preferences.librarySearchTopK", 25);
          const topChunks = scored.filter((c) => c.score >= scoreThreshold).slice(0, topK);

          // Step 4: Emit sources (one per paper, best score)
          const paperSourceMap = new Map<string, { score: number; sectionType: string }>();
          for (const chunk of topChunks) {
               const existing = paperSourceMap.get(chunk.paperTitle);
               if (!existing || chunk.score > existing.score) {
                    paperSourceMap.set(chunk.paperTitle, { score: chunk.score, sectionType: chunk.sectionType });
               }
          }
          const sources = Array.from(paperSourceMap.entries()).map(([title, { score, sectionType }]) => ({
               pageContent: "",
               metadata: { title, url: "", sectionType, score },
          }));

          emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));

          // Step 5: Generate response
          emitter.emit(
               "data",
               JSON.stringify({
                    type: "status",
                    data: { stage: "generating", message: "Generating answer..." },
               })
          );

          const context = buildContextString(topChunks);
          const systemPrompt = getPdfSystemPrompt(context, systemInstructions);

          const chatHistory: BaseMessage[] = history.flatMap(([role, content]): BaseMessage[] =>
               role === "human" ? [new HumanMessage(content)] : [new AIMessage(content)]
          );

          const llmStream = await llm.stream([
               new SystemMessage(systemPrompt),
               ...chatHistory,
               new HumanMessage(query),
          ]);

          for await (const chunk of llmStream) {
               const text = typeof chunk.content === "string" ? chunk.content : "";
               if (text) {
                    emitter.emit("data", JSON.stringify({ type: "response", data: text }));
               }
          }

          emitter.emit("end");
     } catch (err: any) {
          console.error("[pdfContext] Search failed:", err);
          emitter.emit("error", JSON.stringify({ data: err?.message ?? "PDF context search failed" }));
     }
}

export class PdfContextAgent {
     async searchAndAnswer(
          message: string,
          history: BaseMessage[],
          llm: BaseChatModel,
          systemInstructions: string,
          paperIds: number[]
     ): Promise<EventEmitter> {
          const emitter = new EventEmitter();
          const historyTuples = messagesToTuples(history);
          setImmediate(() => executeSearch(emitter, message, historyTuples, llm, systemInstructions, paperIds));
          return emitter;
     }
}
