import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import EventEmitter from "events";
import { and, inArray, or, eq } from "drizzle-orm";
import db from "@/server/db";
import { papers, paperSections } from "@/server/db/schema";
import { getTestPdfOrganizerPrompt } from "@/lib/prompts/pdfContext";

export interface PdfContextSource {
     pageContent: string;
     metadata: { title: string; paperId: number };
}

export interface PdfContextPreprocessResult {
     message: string;
     reconstructedText: string;
     sources: PdfContextSource[];
}

/**
 * Preprocessing-only variant of PdfContextAgent.
 * Fetches paper metadata and sections from the DB, reconstructs text with
 * headers and figure captions, and builds source metadata.
 * No LLM call — returns structured context for external consumption (MCP).
 */
export async function preprocessPdfContext(
     message: string,
     paperIds: number[],
): Promise<PdfContextPreprocessResult> {
     console.log("[pdfContext] Preprocessing with paperIds:", paperIds);

     const paperRows = db
          .select({ id: papers.id, title: papers.title, fileName: papers.fileName })
          .from(papers)
          .where(inArray(papers.id, paperIds))
          .all();

     console.log("[pdfContext] Found %d paper(s)", paperRows.length);

     const sections = db
          .select({
               paperId: paperSections.paperId,
               sectionType: paperSections.sectionType,
               content: paperSections.content,
          })
          .from(paperSections)
          .where(
               and(
                    inArray(paperSections.paperId, paperIds),
                    or(
                         eq(paperSections.sectionType, "main_text"),
                         eq(paperSections.sectionType, "figure_captions"),
                    ),
               ),
          )
          .all();

     console.log("[pdfContext] Found %d section(s) (main_text + figure_captions)", sections.length);

     const mainTextByPaper = new Map<number, string>();
     const captionsByPaper = new Map<number, string>();
     for (const s of sections) {
          if (s.sectionType === "main_text") {
               mainTextByPaper.set(s.paperId, s.content);
          } else if (s.sectionType === "figure_captions") {
               captionsByPaper.set(s.paperId, s.content);
          }
     }

     const reconstructedParts: string[] = [];
     for (const paper of paperRows) {
          const mainText = mainTextByPaper.get(paper.id);
          if (mainText) {
               const captions = captionsByPaper.get(paper.id);
               let combined = `## [Paper ${paper.id}] ${paper.title || paper.fileName}\n\n${mainText}`;
               if (captions) {
                    combined += `\n\n### Figure Captions\n\n${captions}`;
               }
               reconstructedParts.push(combined);
          }
     }

     if (reconstructedParts.length === 0) {
          return { message, reconstructedText: "", sources: [] };
     }

     const reconstructedText = reconstructedParts.join("\n\n---\n\n");

     const sources: PdfContextSource[] = paperRows
          .filter((p) => mainTextByPaper.has(p.id))
          .map((p) => ({
               pageContent: mainTextByPaper.get(p.id)!.slice(0, 200),
               metadata: { title: p.title || p.fileName, paperId: p.id },
          }));

     return { message, reconstructedText, sources };
}

export class PdfContextAgent {
     async searchAndAnswer(
          _message: string,
          _history: BaseMessage[],
          llm: BaseChatModel,
          _systemInstructions: string,
          attachedPaperIds: number[],
     ): Promise<EventEmitter> {
          const emitter = new EventEmitter();
          setImmediate(() =>
               this.execute(emitter, _message, llm, attachedPaperIds),
          );
          return emitter;
     }

     private async execute(
          emitter: EventEmitter,
          message: string,
          llm: BaseChatModel,
          paperIds: number[],
     ): Promise<void> {
          try {
               emitter.emit(
                    "data",
                    JSON.stringify({
                         type: "status",
                         data: { stage: "retrieving", message: "Fetching paper data..." },
                    }),
               );

               const { reconstructedText, sources } = await preprocessPdfContext(message, paperIds);

               if (!reconstructedText) {
                    emitter.emit(
                         "data",
                         JSON.stringify({
                              type: "response",
                              data: "No reconstructed text found for the selected papers.",
                         }),
                    );
                    emitter.emit("end");
                    return;
               }

               emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));

               if (message === "Test") {
                    // Echo back the paper reconstruction result directly
                    emitter.emit("data", JSON.stringify({ type: "response", data: reconstructedText }));
               } else {
                    // Use test organizer prompt to extract Figure 1 description
                    emitter.emit(
                         "data",
                         JSON.stringify({
                              type: "status",
                              data: { stage: "generating", message: "Extracting Figure 1 description..." },
                         }),
                    );

                    const organizerPrompt = getTestPdfOrganizerPrompt(reconstructedText);
                    console.log("[pdfContext] Test organizer prompt length: %d chars", organizerPrompt.length);

                    const llmStream = await llm.stream([
                         new SystemMessage(organizerPrompt),
                         new HumanMessage("Extract all passages related to Figure 1 from the paper text above."),
                    ]);

                    for await (const chunk of llmStream) {
                         const text = typeof chunk.content === "string" ? chunk.content : "";
                         if (!text) continue;
                         emitter.emit("data", JSON.stringify({ type: "response", data: text }));
                    }
               }

               emitter.emit("end");
          } catch (err: any) {
               console.error("[pdfContext] Failed:", err);
               emitter.emit(
                    "data",
                    JSON.stringify({
                         type: "response",
                         data: `An error occurred while processing the papers: ${err?.message ?? "unknown error"}`,
                    }),
               );
               emitter.emit("end");
          }
     }
}
