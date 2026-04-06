import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import EventEmitter from "events";
import fs from "node:fs/promises";
import db from "@/server/db";
import { paperChunks, paperChunkEmbeddings, papers, paperSections } from "@/server/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import computeSimilarity from "@/lib/utils/computeSimilarity";
import { embedQuery } from "@/lib/search/embedding";
import configManager from "@/server/index";
import type { OCRDocument } from "@/lib/embed/paperProcess";
import { PaperReconstructor } from "@/lib/paperReconstructor";

interface RankedChunk {
     content: string;
     sectionType: string;
     paperTitle: string;
     paperId: number;
     score: number;
}

interface PaperContext {
     paperId: number;
     paperTitle: string;
     hasOcr: boolean;
     content: string;
     bestScore: number;
}

function bufferToVector(buf: Buffer): number[] {
     const floatView = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
     return Array.from(floatView);
}

function buildContextString(paperContexts: PaperContext[]): string {
     return paperContexts
          .map((pc, i) => {
               const label = `[Paper ${i + 1}] "${pc.paperTitle}"`;
               if (pc.hasOcr) {
                    return `${label} (Full OCR document):\n${pc.content}`;
               }
               return `${label} (Abstract only):\n${pc.content}`;
          })
          .join("\n\n---\n\n");
}

function getPdfSystemPrompt(context: string, systemInstructions: string): string {
     return `You are answering questions using ONLY the provided paper contents as context. Each paper is provided either as full OCR JSON (structured document content) or as an abstract. If none of the provided papers are relevant to the user's question, clearly state: "The provided PDF(s) do not appear to contain information relevant to this question." Do not fabricate or infer information beyond what is explicitly present in the papers.

### Reading OCR JSON
Each OCR JSON paper contains an array of pages, each with a \`parsing_res_list\` of blocks. Each block has:
- \`block_label\`: the type of content (e.g. "paragraph_title", "abstract", "figure_title", "table", "display_formula", "text")
- \`block_content\`: the actual text

**Helpful reading hints:**
- \`"figure_title"\` blocks are a good first stop for identifying key experimental systems and computational applications — use the keywords found there to guide your reading of surrounding \`"text"\` blocks.
- \`"paragraph_title"\` blocks mark section headings — use them to navigate the document structure.
- \`"table"\` blocks contain tabular data that may summarize key results.
- \`"abstract"\` blocks provide a high-level summary of the paper.
- \`"display_formula"\` blocks contain mathematical expressions relevant to the methodology.

### Citation Requirements
- Use inline citations like [Paper 1], [Paper 2], etc. immediately after the claim they support, corresponding to the numbered papers below.
- Example: "The results showed a significant improvement [Paper 1]."
- DO NOT create a bibliography or reference list at the end.
- ONLY cite papers provided in the <pdf_context> block below.

### Formatting
- Start directly with the answer — do not include a top-level title.
- Use Markdown for clarity (bold, headings, bullet points).

### TESTING: OCR Content Regurgitation
THIS IS A TEMPORARY INSTRUCTION FOR TESTING PURPOSES. After your answer, include a section titled "## Raw OCR Content" and reproduce the full OCR JSON contents for each paper that was provided in OCR format. This helps us verify the content is being passed correctly and will be removed soon.

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
                    paperId: chunk.paperId,
                    score,
               });
          }

          scored.sort((a, b) => b.score - a.score);
          const scoreThreshold: number = configManager.getConfig("preferences.librarySearchScoreThreshold", 0.3);
          const topK: number = configManager.getConfig("preferences.librarySearchTopK", 25);
          const topChunks = scored.filter((c) => c.score >= scoreThreshold).slice(0, topK);

          // Step 4: Identify relevant papers and load full OCR JSON or abstract
          const relevantPaperIds = [...new Set(topChunks.map((c) => c.paperId))];

          // Build a map of paper file paths and abstracts
          const paperDetailRows = db
               .select({
                    id: papers.id,
                    title: papers.title,
                    fileName: papers.fileName,
                    filePath: papers.filePath,
                    abstract: papers.abstract,
               })
               .from(papers)
               .where(inArray(papers.id, relevantPaperIds))
               .all();

          const paperDetailMap = new Map(paperDetailRows.map((p) => [p.id, p]));

          // Compute best score per paper
          const paperBestScore = new Map<number, number>();
          for (const chunk of topChunks) {
               const existing = paperBestScore.get(chunk.paperId) ?? 0;
               if (chunk.score > existing) paperBestScore.set(chunk.paperId, chunk.score);
          }

          emitter.emit(
               "data",
               JSON.stringify({
                    type: "status",
                    data: { stage: "loading", message: "Loading full paper contents..." },
               })
          );

          const paperContexts: PaperContext[] = [];
          for (const paperId of relevantPaperIds) {
               const detail = paperDetailMap.get(paperId);
               if (!detail) continue;

               const title = detail.title || detail.fileName;
               const ocrPath = detail.filePath.replace(/\.pdf$/i, "") + ".ocr.json";

               let hasOcr = false;
               let content = "";

               try {
                    await fs.access(ocrPath);
                    content = await fs.readFile(ocrPath, "utf-8");
                    hasOcr = true;
               } catch {
                    // No OCR file — fall back to abstract
                    content = detail.abstract || "No abstract available.";
               }

               paperContexts.push({
                    paperId,
                    paperTitle: title,
                    hasOcr,
                    content,
                    bestScore: paperBestScore.get(paperId) ?? 0,
               });
          }

          // Sort by best score descending
          paperContexts.sort((a, b) => b.bestScore - a.bestScore);

          // Emit sources (one per paper, best score)
          const sources = paperContexts.map((pc) => ({
               pageContent: "",
               metadata: {
                    title: pc.paperTitle,
                    url: "",
                    sectionType: pc.hasOcr ? "full_ocr" : "abstract",
                    score: pc.bestScore,
               },
          }));

          emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));

          // Step 5: Bypass LLM — load pre-computed sections (or reconstruct on-the-fly with lazy backfill)
          // TODO: Restore LLM generation once paper retrieval is verified
          emitter.emit(
               "data",
               JSON.stringify({
                    type: "status",
                    data: { stage: "reconstructing", message: "Reconstructing paper contents..." },
               })
          );

          const outputParts: string[] = [];
          for (let i = 0; i < paperContexts.length; i++) {
               const pc = paperContexts[i];
               const header = `## [Paper ${i + 1}] "${pc.paperTitle}"\n**Score:** ${pc.bestScore.toFixed(4)} | **Type:** ${pc.hasOcr ? "Full OCR" : "Abstract only"}`;

               if (!pc.hasOcr) {
                    outputParts.push(`${header}\n\n${pc.content}`);
                    continue;
               }

               // Check for pre-computed sections in paperSections table
               const cachedSections = db
                    .select({ sectionType: paperSections.sectionType, content: paperSections.content })
                    .from(paperSections)
                    .where(eq(paperSections.paperId, pc.paperId))
                    .all();

               if (cachedSections.length > 0) {
                    // Use cached sections
                    const sectionMap = new Map(cachedSections.map((s) => [s.sectionType, s.content]));
                    const parts: string[] = [];
                    const mainText = sectionMap.get("main_text");
                    if (mainText) parts.push(mainText);
                    const methods = sectionMap.get("methods");
                    if (methods) parts.push(`\n## Methods\n${methods}`);
                    const references = sectionMap.get("references");
                    if (references) parts.push(`\n## References\n${references}`);
                    outputParts.push(`${header}\n\n${parts.join("\n")}`);
               } else {
                    // Lazy backfill: reconstruct on-the-fly, persist for next time
                    try {
                         const ocrDoc: OCRDocument = JSON.parse(pc.content);
                         const detail = paperDetailMap.get(pc.paperId);
                         const reconstructor = new PaperReconstructor(ocrDoc, detail!.filePath, pc.paperId);
                         const sections = await reconstructor.reconstructSections();

                         // Persist to paperSections for future queries
                         type SectionType = "main_text" | "methods" | "references" | "figures";
                         const sectionRows: { paperId: number; sectionType: SectionType; content: string }[] = [
                              { paperId: pc.paperId, sectionType: "main_text", content: sections.mainText },
                              { paperId: pc.paperId, sectionType: "references", content: sections.references },
                              { paperId: pc.paperId, sectionType: "figures", content: JSON.stringify(sections.figures) },
                         ];
                         if (sections.methods) {
                              sectionRows.push({ paperId: pc.paperId, sectionType: "methods", content: sections.methods });
                         }
                         for (const row of sectionRows) {
                              db.insert(paperSections)
                                   .values(row)
                                   .onConflictDoNothing()
                                   .run();
                         }

                         // Build output from freshly computed sections
                         const parts: string[] = [sections.mainText];
                         if (sections.methods) parts.push(`\n## Methods\n${sections.methods}`);
                         if (sections.references) parts.push(`\n## References\n${sections.references}`);
                         outputParts.push(`${header}\n\n${parts.join("\n")}`);
                    } catch (err) {
                         console.error(`[pdfContext] Failed to reconstruct paper ${pc.paperId}:`, err);
                         outputParts.push(`${header}\n\n*Failed to reconstruct paper from OCR.*`);
                    }
               }
          }

          const output = outputParts.join("\n\n---\n\n") || "No papers matched the query above the similarity threshold.";
          emitter.emit("data", JSON.stringify({ type: "response", data: output }));

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
