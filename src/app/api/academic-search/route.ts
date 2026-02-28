import crypto from "crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import db from "@/server/db";
import { chats, messages as messagesSchema } from "@/server/db/schema";
import { academicSearches } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { createAcademicSearchStream } from "@/lib/search/academicSearch/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
     query: z.string().min(1),
     chatId: z.string().min(1),
     messageId: z.string().min(1),
     history: z
          .array(z.tuple([z.string(), z.string()]))
          .optional()
          .default([]),
     chatModel: z.object({
          providerId: z.string(),
          key: z.string(),
     }),
     systemInstructions: z.string().nullable().optional().default(""),
});

type Body = z.infer<typeof bodySchema>;

function getModelRegistry() {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("@/server/providerRegistry").default;
}

const handleEmitterEvents = (
     stream: NodeJS.EventEmitter,
     writer: WritableStreamDefaultWriter,
     encoder: TextEncoder,
     chatId: string,
     messageId: string,
     query: string,
) => {
     let receivedMessage = "";
     let receivedSources: any[] = [];
     const aiMessageId = crypto.randomBytes(7).toString("hex");

     stream.on("data", (data: string) => {
          const parsedData = JSON.parse(data);

          if (parsedData.type === "response") {
               writer.write(
                    encoder.encode(
                         JSON.stringify({
                              type: "message",
                              data: parsedData.data,
                              messageId: aiMessageId,
                         }) + "\n",
                    ),
               );
               receivedMessage += parsedData.data;
          } else if (parsedData.type === "sources") {
               receivedSources = parsedData.data ?? [];
               writer.write(
                    encoder.encode(
                         JSON.stringify({
                              type: "sources",
                              data: receivedSources,
                              messageId: aiMessageId,
                         }) + "\n",
                    ),
               );

               const sourceMessageId = crypto.randomBytes(7).toString("hex");
               db.insert(messagesSchema)
                    .values({
                         chatId,
                         messageId: sourceMessageId,
                         role: "source",
                         sources: receivedSources,
                         createdAt: new Date().toString(),
                    })
                    .execute();
          }
     });

     stream.on("end", () => {
          writer.write(encoder.encode(JSON.stringify({ type: "messageEnd" }) + "\n"));
          writer.close();

          // Persist the assistant response message
          db.insert(messagesSchema)
               .values({
                    content: receivedMessage,
                    chatId,
                    messageId: aiMessageId,
                    role: "assistant",
                    createdAt: new Date().toString(),
               })
               .execute();

          // Persist dedicated academic search history record
          db.insert(academicSearches)
               .values({
                    chatId,
                    query,
                    sources: receivedSources,
                    response: receivedMessage,
                    createdAt: new Date().toISOString(),
               })
               .execute();
     });

     stream.on("error", (data: string) => {
          try {
               const parsedData = JSON.parse(data);
               writer.write(encoder.encode(JSON.stringify({ type: "error", data: parsedData.data })));
          } catch {
               writer.write(encoder.encode(JSON.stringify({ type: "error", data: "Academic search failed" })));
          }
          writer.close();
     });
};

export const POST = async (req: Request) => {
     try {
          const reqBody = await req.json();
          const parseResult = bodySchema.safeParse(reqBody);

          if (!parseResult.success) {
               return Response.json(
                    { message: "Invalid request body", error: parseResult.error.issues },
                    { status: 400 },
               );
          }

          const body = parseResult.data as Body;

          // Load the chat model lazily to avoid loading native modules at bundle time
          const modelRegistry = getModelRegistry();
          const provider = modelRegistry.getProviderById(body.chatModel.providerId);
          if (!provider) {
               return Response.json(
                    { message: `Provider ${body.chatModel.providerId} not found` },
                    { status: 400 },
               );
          }

          const llm = (await provider.provider.loadChatModel(body.chatModel.key)) as BaseChatModel;

          // Ensure chat exists in DB for conversation linking
          const existingChat = await db.query.chats.findFirst({
               where: eq(chats.id, body.chatId),
          });
          if (!existingChat) {
               await db
                    .insert(chats)
                    .values({
                         id: body.chatId,
                         title: body.query,
                         createdAt: new Date().toString(),
                         files: [],
                    })
                    .execute();
          }

          // Save the user's query as a message
          const messageExists = await db.query.messages.findFirst({
               where: eq(messagesSchema.messageId, body.messageId),
          });
          if (!messageExists) {
               await db
                    .insert(messagesSchema)
                    .values({
                         content: body.query,
                         chatId: body.chatId,
                         messageId: body.messageId,
                         role: "user",
                         createdAt: new Date().toString(),
                    })
                    .execute();
          }

          // Start the academic search stream
          const stream = createAcademicSearchStream(
               body.query,
               body.history,
               llm,
               body.systemInstructions ?? "",
          );

          const responseStream = new TransformStream();
          const writer = responseStream.writable.getWriter();
          const encoder = new TextEncoder();

          handleEmitterEvents(stream, writer, encoder, body.chatId, body.messageId, body.query);

          return new Response(responseStream.readable, {
               headers: {
                    "Content-Type": "text/event-stream",
                    Connection: "keep-alive",
                    "Cache-Control": "no-cache, no-transform",
               },
          });
     } catch (err: any) {
          console.error("[academic-search] Route error:", err);
          return Response.json({ message: "An error occurred during academic search" }, { status: 500 });
     }
};
