import "tsconfig-paths/register";

import http from "http";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import db from "@/server/db";
import { chats, messages as messagesSchema } from "@/server/db/schema";
import {
     preprocessPdfContext,
     type PdfContextPreprocessResult,
} from "@/lib/search/pdfContext/agent";

// ── Tool registration ───────────────────────────────────────────────────────

function createServer(): McpServer {
     const server = new McpServer({
          name: "GoFetch",
          version: "0.1.0",
     });

     // Tool 1: queryPdfContext
     server.tool(
          "queryPdfContext",
          "Preprocess PDF paper context for a query. Returns reconstructed paper text and source metadata without making any LLM call — the caller is expected to reason over the context itself.",
          {
               message: z.string().describe("The user/agent query"),
               paperIds: z
                    .array(z.number().int())
                    .describe("IDs of papers to use as context (from the PdfSelector popover)"),
          },
          async ({ message, paperIds }): Promise<{
               content: { type: "text"; text: string }[];
          }> => {
               const result: PdfContextPreprocessResult =
                    await preprocessPdfContext(message, paperIds);

               return {
                    content: [
                         {
                              type: "text" as const,
                              text: JSON.stringify(
                                   {
                                        message: result.message,
                                        reconstructedText: result.reconstructedText,
                                        sources: result.sources,
                                   },
                                   null,
                                   2,
                              ),
                         },
                    ],
               };
          },
     );

     // Tool 2: submitChatResponse
     server.tool(
          "submitChatResponse",
          "Write an externally-crafted assistant response into a GoFetch chat session so it appears in the UI.",
          {
               chatId: z.string().describe("Target chat session ID"),
               responseText: z.string().describe("The assistant message content to display"),
               sources: z
                    .array(
                         z.object({
                              pageContent: z.string(),
                              metadata: z.record(z.string(), z.unknown()),
                         }),
                    )
                    .optional()
                    .describe("Source documents to attach (same shape as SourceMessage.sources)"),
               createIfMissing: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("If true, creates the chat entry when chatId doesn't exist yet"),
          },
          async ({ chatId, responseText, sources, createIfMissing }) => {
               const chat = await db.query.chats.findFirst({
                    where: eq(chats.id, chatId),
               });

               if (!chat) {
                    if (!createIfMissing) {
                         return {
                              content: [
                                   {
                                        type: "text" as const,
                                        text: JSON.stringify({
                                             success: false,
                                             error: `Chat "${chatId}" not found. Set createIfMissing to true to create it.`,
                                        }),
                                   },
                              ],
                              isError: true,
                         };
                    }

                    await db
                         .insert(chats)
                         .values({
                              id: chatId,
                              title: "MCP Chat",
                              createdAt: new Date().toString(),
                         })
                         .execute();
               }

               const assistantMessageId = crypto.randomBytes(7).toString("hex");

               await db
                    .insert(messagesSchema)
                    .values({
                         content: responseText,
                         chatId,
                         messageId: assistantMessageId,
                         role: "assistant",
                         createdAt: new Date().toString(),
                    })
                    .execute();

               if (sources && sources.length > 0) {
                    const sourceMessageId = crypto.randomBytes(7).toString("hex");

                    await db
                         .insert(messagesSchema)
                         .values({
                              chatId,
                              messageId: sourceMessageId,
                              role: "source",
                              sources: sources as any,
                              createdAt: new Date().toString(),
                         })
                         .execute();
               }

               return {
                    content: [
                         {
                              type: "text" as const,
                              text: JSON.stringify({
                                   success: true,
                                   chatId,
                                   messageId: assistantMessageId,
                              }),
                         },
                    ],
               };
          },
     );

     return server;
}

// ── HTTP server (Streamable HTTP transport) ─────────────────────────────────

const MCP_PORT = parseInt(process.env.MCP_PORT || "3001", 10);

const transports: Record<string, StreamableHTTPServerTransport> = {};

function parseBody(req: http.IncomingMessage): Promise<unknown> {
     return new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
               try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
               } catch (e) {
                    reject(e);
               }
          });
          req.on("error", reject);
     });
}

const httpServer = http.createServer(async (req, res) => {
     if (req.url !== "/mcp") {
          res.writeHead(404);
          res.end("Not found");
          return;
     }

     if (req.method === "POST") {
          const body = await parseBody(req);
          const sessionId = req.headers["mcp-session-id"] as string | undefined;

          let transport: StreamableHTTPServerTransport;

          if (sessionId && transports[sessionId]) {
               transport = transports[sessionId];
          } else if (!sessionId && isInitializeRequest(body)) {
               transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID(),
                    onsessioninitialized: (sid: string) => {
                         transports[sid] = transport;
                    },
               });

               transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid) delete transports[sid];
               };

               const server = createServer();
               await server.connect(transport);
          } else {
               res.writeHead(400, { "Content-Type": "application/json" });
               res.end(
                    JSON.stringify({
                         jsonrpc: "2.0",
                         error: { code: -32000, message: "Bad Request: No valid session ID" },
                         id: null,
                    }),
               );
               return;
          }

          await transport.handleRequest(req, res, body);
     } else if (req.method === "GET") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (!sessionId || !transports[sessionId]) {
               res.writeHead(400);
               res.end("Invalid or missing session ID");
               return;
          }
          await transports[sessionId].handleRequest(req, res);
     } else if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (!sessionId || !transports[sessionId]) {
               res.writeHead(400);
               res.end("Invalid or missing session ID");
               return;
          }
          await transports[sessionId].handleRequest(req, res);
     } else {
          res.writeHead(405);
          res.end("Method not allowed");
     }
});

httpServer.listen(MCP_PORT, () => {
     console.error(`[GoFetch MCP] Streamable HTTP server listening on http://localhost:${MCP_PORT}/mcp`);
});

process.on("SIGINT", async () => {
     for (const sid in transports) {
          await transports[sid].close().catch(() => {});
          delete transports[sid];
     }
     process.exit(0);
});
