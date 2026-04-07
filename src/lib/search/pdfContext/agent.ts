import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import EventEmitter from "events";
import { and, inArray, or, eq } from "drizzle-orm";
import db from "@/server/db";
import { papers, paperSections } from "@/server/db/schema";
import { getPdfOrganizerPrompt } from "@/lib/prompts/pdfContext";

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
               this.execute(emitter, llm, attachedPaperIds),
          );
          return emitter;
     }

     private async execute(
          emitter: EventEmitter,
          llm: BaseChatModel,
          paperIds: number[],
     ): Promise<void> {
          try {
               console.log("[pdfContext] Starting with paperIds:", paperIds);

               // Fetch paper metadata and reconstructed main_text sections
               emitter.emit(
                    "data",
                    JSON.stringify({
                         type: "status",
                         data: { stage: "retrieving", message: "Fetching paper data..." },
                    }),
               );

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

               // Build combined reconstructed text with paper headers
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

               const reconstructedText = reconstructedParts.join("\n\n---\n\n");

               // Emit sources (paper metadata)
               const sources = paperRows
                    .filter((p) => mainTextByPaper.has(p.id))
                    .map((p) => ({
                         pageContent: mainTextByPaper.get(p.id)!.slice(0, 200),
                         metadata: { title: p.title || p.fileName, paperId: p.id },
                    }));
               emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));

               // DEBUG: dump raw reconstruction to the client instead of calling the LLM
               emitter.emit(
                    "data",
                    JSON.stringify({ type: "response", data: reconstructedText }),
               );

               // // Use organizer prompt to reorganize text by figures
               // emitter.emit(
               //      "data",
               //      JSON.stringify({
               //           type: "status",
               //           data: { stage: "generating", message: "Organizing figure descriptions..." },
               //      }),
               // );

               // const organizerPrompt = getPdfOrganizerPrompt(reconstructedText);
               // console.log("[pdfContext] Organizer prompt length: %d chars", organizerPrompt.length);

               // const llmStream = await llm.stream([
               //      new SystemMessage(organizerPrompt),
               //      new HumanMessage("Reorganize the paper text above according to the instructions."),
               // ]);

               // let outputStarted = false;
               // let buffer = "";
               // for await (const chunk of llmStream) {
               //      const text = typeof chunk.content === "string" ? chunk.content : "";
               //      if (!text) continue;

               //      if (outputStarted) {
               //           buffer += text;
               //           const endIdx = buffer.indexOf("</output>");
               //           if (endIdx !== -1) {
               //                const finalText = buffer.slice(0, endIdx);
               //                if (finalText) {
               //                     emitter.emit("data", JSON.stringify({ type: "response", data: finalText }));
               //                }
               //                break;
               //           }
               //           const safe = buffer.length - "</output>".length;
               //           if (safe > 0) {
               //                emitter.emit("data", JSON.stringify({ type: "response", data: buffer.slice(0, safe) }));
               //                buffer = buffer.slice(safe);
               //           }
               //      } else {
               //           buffer += text;
               //           const startIdx = buffer.indexOf("<output>");
               //           if (startIdx !== -1) {
               //                outputStarted = true;
               //                buffer = buffer.slice(startIdx + "<output>".length);
               //           }
               //      }
               // }

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
