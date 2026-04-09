import { spawn } from "child_process";
import EventEmitter from "events";
import { preprocessPdfContext } from "@/lib/search/pdfContext/agent";
import { preprocessWebSearch } from "@/lib/search/webSearch/agent";
import { preprocessAcademicSearch } from "@/lib/search/academicSearch/agent";
import { formatResultsForPrompt, extractCitedSources, remapCitationsInText } from "@/lib/search";
import { getPdfOrganizerPrompt } from "@/lib/prompts/pdfContext";
import { getWebWriterPrompt } from "@/lib/prompts/webSearch";
import { getAcademicWriterPrompt } from "@/lib/prompts/academicSearch";

// ── Configuration ───────────────────────────────────────────────────────────

const COPILOT_COMMAND = process.env.COPILOT_COMMAND ?? "copilot";
const COPILOT_MODEL = process.env.COPILOT_MODEL; // e.g. "claude-sonnet-4.5"

/**
 * Base system instruction for the generic Copilot path (no focus-mode-specific
 * writer prompt).  Ensures the response renders well in the markdown-to-jsx
 * chat window regardless of which Copilot-backed model is active.
 */
const COPILOT_MARKDOWN_PROMPT = `Respond using Markdown formatting for clarity. Use headings (##), bold, bullet points, numbered lists, and fenced code blocks where appropriate. Start directly with the answer — do not include a top-level title or repeat the question.`;

export interface CopilotOptions {
     model?: string;
}

// ── Low-level: spawn Copilot with a prompt ──────────────────────────────────

/**
 * Spawn the Copilot CLI headlessly and stream the response as events
 * compatible with handleEmitterEvents in the chat route.
 *
 * The prompt is passed via `-p` (non-interactive mode).  The process writes
 * its response to stdout and exits.
 */
export function spawnCopilot(
     prompt: string,
     options?: CopilotOptions,
): EventEmitter {
     const emitter = new EventEmitter();

     setImmediate(() => {
          const model = options?.model ?? COPILOT_MODEL;

          const [cmd, ...cmdPrefix] = COPILOT_COMMAND.split(/\s+/);

          // When invoked via "gh copilot", insert "--" so gh doesn't
          // swallow flags meant for the Copilot CLI.
          const separator = cmdPrefix.length > 0 ? ["--"] : [];

          // Pass the prompt via stdin instead of -p to avoid ENAMETOOLONG
          // on Windows when the prompt (system instructions + history + PDF
          // context) exceeds the ~32 KB CreateProcess command-line limit.
          // Copilot reads from stdin when it detects a pipe (non-TTY).
          const args = [
               ...cmdPrefix,
               ...separator,
               "-s",
               "--no-ask-user",
               "--allow-all-tools",
          ];

          if (model) {
               args.push("--model", model);
          }

          emitter.emit(
               "data",
               JSON.stringify({
                    type: "status",
                    data: { stage: "generating", message: "Waiting for Copilot..." },
               }),
          );

          const proc = spawn(cmd, args, {
               stdio: ["pipe", "pipe", "pipe"],
               env: { ...process.env },
          });

          proc.stdin!.end(prompt);

          proc.stdout.on("data", (chunk: Buffer) => {
               emitter.emit(
                    "data",
                    JSON.stringify({ type: "response", data: chunk.toString() }),
               );
          });

          let stderrChunks: string[] = [];
          proc.stderr.on("data", (chunk: Buffer) => {
               const text = chunk.toString().trim();
               if (text) {
                    console.error("[copilot stderr]", text);
                    stderrChunks.push(text);
               }
          });

          proc.on("close", (code) => {
               if (code !== 0) {
                    const detail = stderrChunks.length > 0
                         ? `\n\n\`\`\`\n${stderrChunks.join("\n")}\n\`\`\``
                         : "";
                    emitter.emit(
                         "data",
                         JSON.stringify({
                              type: "response",
                              data: `\n\n*(Copilot exited with code ${code})*${detail}`,
                         }),
                    );
               }
               emitter.emit("end");
          });

          proc.on("error", (err) => {
               emitter.emit(
                    "data",
                    JSON.stringify({
                         type: "error",
                         data: `Failed to launch Copilot: ${err.message}`,
                    }),
               );
               emitter.emit("end");
          });
     });

     return emitter;
}

// ── High-level: handle a full chat request via Copilot ──────────────────────

interface CopilotChatParams {
     message: string;
     focusMode: string;
     history: [string, string][];
     attachedPaperIds?: number[];
     systemInstructions?: string | null;
     model?: string;
}

/**
 * Preprocess based on the focus mode / attached papers, build the full prompt,
 * and spawn Copilot.  Returns an EventEmitter with the same event protocol as
 * the existing search agents ("data", "end", "error").
 */
export async function handleCopilotChat(
     params: CopilotChatParams,
): Promise<EventEmitter> {
     const { message, focusMode, history, attachedPaperIds, systemInstructions, model } = params;
     const copilotOpts: CopilotOptions = model ? { model } : {};

     // ── PDF context path (no LLM needed for preprocessing) ────────────────
     if (attachedPaperIds && attachedPaperIds.length > 0) {
          const { reconstructedText, sources } = await preprocessPdfContext(
               message,
               attachedPaperIds,
          );

          const systemPrompt = reconstructedText
               ? getPdfOrganizerPrompt(reconstructedText)
               : "No paper text was found for the selected papers. Let the user know.";

          const fullPrompt = `${systemPrompt}\n\nUser query: ${message}`;

          const emitter = spawnCopilot(fullPrompt, copilotOpts);

          // Emit sources immediately so the frontend can show them
          if (sources.length > 0) {
               setImmediate(() => {
                    emitter.emit(
                         "data",
                         JSON.stringify({ type: "sources", data: sources }),
                    );
               });
          }

          return emitter;
     }

     // ── Shared history block ─────────────────────────────────────────────
     const historyBlock = history.length > 0
          ? history
                 .map(([role, content]) => `${role === "human" ? "User" : "Assistant"}: ${content}`)
                 .join("\n")
          : "";

     // ── Code / generic path (no SearXNG needed) ─────────────────────────
     // When no search-specific focus mode is active, spawn Copilot directly
     // with a lightweight markdown instruction so the response renders well.
     if (focusMode !== "academic" && focusMode !== "default") {
          const fullPrompt = [
               COPILOT_MARKDOWN_PROMPT,
               systemInstructions ? `\nAdditional instructions from the user:\n${systemInstructions}` : "",
               historyBlock ? `\n<conversation_history>\n${historyBlock}\n</conversation_history>` : "",
               `\nUser query: ${message}`,
          ].join("\n");

          return spawnCopilot(fullPrompt, copilotOpts);
     }

     // ── Search path (web / academic) ─────────────────────────────────────
     // Run SearXNG preprocessing (no LLM — raw query fallback) and inject
     // real search results into the Copilot prompt so responses are grounded.
     let writerInstructions: string;
     let academicSources: { pageContent: string; metadata: { title: string; url: string } }[] = [];
     const emitter = new EventEmitter();

     setImmediate(async () => {
          try {
               if (focusMode === "academic") {
                    const { filteredResults, sources } = await preprocessAcademicSearch(message, history);
                    const context = formatResultsForPrompt(filteredResults, "Abstract");
                    writerInstructions = getAcademicWriterPrompt(context, systemInstructions ?? "");
                    academicSources = sources;
               } else {
                    const { searchResults, sources } = await preprocessWebSearch(message, history);
                    const context = formatResultsForPrompt(searchResults, "Content");
                    writerInstructions = getWebWriterPrompt(context, systemInstructions ?? "");

                    if (sources.length > 0) {
                         emitter.emit("data", JSON.stringify({ type: "sources", data: sources }));
                    }
               }
          } catch (err: any) {
               const mode = focusMode === "academic" ? "Academic search" : "Web search";
               emitter.emit(
                    "data",
                    JSON.stringify({
                         type: "error",
                         data: `SearXNG is not available. ${mode} requires a running SearXNG instance.`,
                    }),
               );
               emitter.emit("end");
               return;
          }

          const fullPrompt = [
               writerInstructions,
               historyBlock ? `\n<conversation_history>\n${historyBlock}\n</conversation_history>` : "",
               `\nUser query: ${message}`,
          ].join("\n");

          const copilotEmitter = spawnCopilot(fullPrompt, copilotOpts);

          // For academic mode, buffer the full response, prune sources to only
          // those actually cited, remap citations, then emit everything together.
          if (focusMode === "academic" && academicSources.length > 0) {
               let accumulatedResponse = "";
               copilotEmitter.on("data", (d) => {
                    const parsed = JSON.parse(d);
                    if (parsed.type === "response") {
                         accumulatedResponse += parsed.data;
                    } else {
                         // Forward non-response events (status, error) immediately
                         emitter.emit("data", d);
                    }
               });
               copilotEmitter.on("end", () => {
                    let finalSources = academicSources;
                    let finalResponse = accumulatedResponse;
                    if (accumulatedResponse && academicSources.length > 0) {
                         const { prunedSources, citationMap } = extractCitedSources(accumulatedResponse, academicSources);
                         if (prunedSources.length > 0) {
                              finalSources = prunedSources;
                              finalResponse = remapCitationsInText(accumulatedResponse, citationMap);
                         }
                    }
                    emitter.emit("data", JSON.stringify({ type: "sources", data: finalSources }));
                    emitter.emit("data", JSON.stringify({ type: "response", data: finalResponse }));
                    emitter.emit("end");
               });
               copilotEmitter.on("error", (e) => emitter.emit("error", e));
          } else {
               // Pipe all Copilot events through to the caller's emitter
               copilotEmitter.on("data", (d) => emitter.emit("data", d));
               copilotEmitter.on("end", () => emitter.emit("end"));
               copilotEmitter.on("error", (e) => emitter.emit("error", e));
          }
     });

     return emitter;
}
