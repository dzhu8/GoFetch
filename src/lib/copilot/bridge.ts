import { spawn } from "child_process";
import EventEmitter from "events";
import { preprocessPdfContext } from "@/lib/search/pdfContext/agent";
import { getPdfOrganizerPrompt } from "@/lib/prompts/pdfContext";
import { getWebWriterPrompt } from "@/lib/prompts/webSearch";
import { getAcademicWriterPrompt } from "@/lib/prompts/academicSearch";

// ── Configuration ───────────────────────────────────────────────────────────

const COPILOT_COMMAND = process.env.COPILOT_COMMAND ?? "copilot";
const COPILOT_MODEL = process.env.COPILOT_MODEL; // e.g. "claude-sonnet-4.5"

export interface CopilotOptions {
     model?: string;
}

// ── Low-level: spawn Copilot with a prompt ──────────────────────────────────

/**
 * Spawn the Copilot CLI headlessly and stream the response as events
 * compatible with handleEmitterEvents in the chat route.
 *
 * The full prompt is written to stdin (avoids OS command-line length limits on
 * Windows ~8 kB / Linux ~2 MB).  The process is expected to write its response
 * to stdout and exit.
 */
export function spawnCopilot(
     prompt: string,
     options?: CopilotOptions,
): EventEmitter {
     const emitter = new EventEmitter();

     setImmediate(() => {
          const model = options?.model ?? COPILOT_MODEL;

          const args = [
               "-p", "-",     // read prompt from stdin
               "-s",          // silent — response text only
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

          const proc = spawn(COPILOT_COMMAND, args, {
               stdio: ["pipe", "pipe", "pipe"],
               env: { ...process.env },
          });

          // Write prompt through stdin to avoid arg-length limits
          proc.stdin.write(prompt);
          proc.stdin.end();

          proc.stdout.on("data", (chunk: Buffer) => {
               emitter.emit(
                    "data",
                    JSON.stringify({ type: "response", data: chunk.toString() }),
               );
          });

          proc.stderr.on("data", (chunk: Buffer) => {
               const text = chunk.toString().trim();
               if (text) console.error("[copilot stderr]", text);
          });

          proc.on("close", (code) => {
               if (code !== 0) {
                    emitter.emit(
                         "data",
                         JSON.stringify({
                              type: "response",
                              data: `\n\n*(Copilot exited with code ${code})*`,
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

     // ── Generic path (web search / academic / default) ────────────────────
     // Without an LLM available for the classifier step, we pass the user's
     // raw query and conversation history directly to Copilot along with the
     // appropriate writer prompt instructions.
     const historyBlock = history.length > 0
          ? history
                 .map(([role, content]) => `${role === "human" ? "User" : "Assistant"}: ${content}`)
                 .join("\n")
          : "";

     let writerInstructions: string;
     if (focusMode === "academic") {
          writerInstructions = getAcademicWriterPrompt(
               "(No pre-fetched results — use your own knowledge or available tools.)",
               systemInstructions ?? "",
          );
     } else {
          writerInstructions = getWebWriterPrompt(
               "(No pre-fetched results — use your own knowledge or available tools.)",
               systemInstructions ?? "",
          );
     }

     const fullPrompt = [
          writerInstructions,
          historyBlock ? `\n<conversation_history>\n${historyBlock}\n</conversation_history>` : "",
          `\nUser query: ${message}`,
     ].join("\n");

     return spawnCopilot(fullPrompt, copilotOpts);
}
