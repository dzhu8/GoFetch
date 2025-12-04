import crypto from "crypto";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { EventEmitter } from "stream";
import db from "@/server/db";
import { chats, messages as messagesSchema, folders } from "@/server/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import modelRegistry from "@/server/providerRegistry";
import { searchHandlers } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const messageSchema = z.object({
     messageId: z.string().min(1),
     chatId: z.string().min(1),
     content: z.string().min(1),
});

const chatModelSchema = z.object({
     providerId: z.string(),
     key: z.string(),
});

const bodySchema = z.object({
     message: messageSchema,
     focusMode: z.string().default("code"),
     history: z
          .array(z.tuple([z.string(), z.string()]))
          .optional()
          .default([]),
     files: z.array(z.string()).optional().default([]),
     folderNames: z.array(z.string()).optional(),
     chatModel: chatModelSchema,
     systemInstructions: z.string().nullable().optional().default(""),
});

type Message = z.infer<typeof messageSchema>;
type Body = z.infer<typeof bodySchema>;

interface FileDetails {
     name: string;
     fileId: string;
}

function getFileDetails(fileId: string): FileDetails {
     return {
          name: fileId,
          fileId: fileId,
     };
}

const safeValidateBody = (data: unknown) => {
     const result = bodySchema.safeParse(data);

     if (!result.success) {
          return {
               success: false as const,
               error: result.error.issues.map((e) => ({
                    path: e.path.join("."),
                    message: e.message,
               })),
          };
     }

     return {
          success: true as const,
          data: result.data,
     };
};

/**
 * Get all registered folder names from the database.
 */
function getAllFolderNames(): string[] {
     const rows = db.select({ name: folders.name }).from(folders).all();
     return rows.map((r) => r.name);
}

/**
 * Get the appropriate search agent based on focus mode.
 */
function getSearchAgent(focusMode: string) {
     const agent = searchHandlers[focusMode];
     if (!agent) {
          // Default to code search if focus mode not found
          return searchHandlers.code;
     }
     return agent;
}

const handleEmitterEvents = async (
     stream: EventEmitter,
     writer: WritableStreamDefaultWriter,
     encoder: TextEncoder,
     chatId: string
) => {
     let receivedMessage = "";
     const aiMessageId = crypto.randomBytes(7).toString("hex");

     stream.on("data", (data) => {
          const parsedData = JSON.parse(data);
          if (parsedData.type === "response") {
               writer.write(
                    encoder.encode(
                         JSON.stringify({
                              type: "message",
                              data: parsedData.data,
                              messageId: aiMessageId,
                         }) + "\n"
                    )
               );

               receivedMessage += parsedData.data;
          } else if (parsedData.type === "sources") {
               writer.write(
                    encoder.encode(
                         JSON.stringify({
                              type: "sources",
                              data: parsedData.data,
                              messageId: aiMessageId,
                         }) + "\n"
                    )
               );

               const sourceMessageId = crypto.randomBytes(7).toString("hex");

               db.insert(messagesSchema)
                    .values({
                         chatId: chatId,
                         messageId: sourceMessageId,
                         role: "source",
                         sources: parsedData.data,
                         createdAt: new Date().toString(),
                    })
                    .execute();
          }
     });

     stream.on("end", () => {
          writer.write(
               encoder.encode(
                    JSON.stringify({
                         type: "messageEnd",
                    }) + "\n"
               )
          );
          writer.close();

          db.insert(messagesSchema)
               .values({
                    content: receivedMessage,
                    chatId: chatId,
                    messageId: aiMessageId,
                    role: "assistant",
                    createdAt: new Date().toString(),
               })
               .execute();
     });

     stream.on("error", (data) => {
          const parsedData = JSON.parse(data);
          writer.write(
               encoder.encode(
                    JSON.stringify({
                         type: "error",
                         data: parsedData.data,
                    })
               )
          );
          writer.close();
     });
};

const handleHistorySave = async (message: Message, humanMessageId: string, files: string[]) => {
     const chat = await db.query.chats.findFirst({
          where: eq(chats.id, message.chatId),
     });

     const fileData: FileDetails[] = files.map(getFileDetails);

     if (!chat) {
          await db
               .insert(chats)
               .values({
                    id: message.chatId,
                    title: message.content,
                    createdAt: new Date().toString(),
                    files: fileData,
               })
               .execute();
     } else if (JSON.stringify(chat.files ?? []) != JSON.stringify(fileData)) {
          db.update(chats)
               .set({
                    files: files.map(getFileDetails),
               })
               .where(eq(chats.id, message.chatId));
     }

     const messageExists = await db.query.messages.findFirst({
          where: eq(messagesSchema.messageId, humanMessageId),
     });

     if (!messageExists) {
          await db
               .insert(messagesSchema)
               .values({
                    content: message.content,
                    chatId: message.chatId,
                    messageId: humanMessageId,
                    role: "user",
                    createdAt: new Date().toString(),
               })
               .execute();
     } else {
          await db
               .delete(messagesSchema)
               .where(and(gt(messagesSchema.id, messageExists.id), eq(messagesSchema.chatId, message.chatId)))
               .execute();
     }
};

export const POST = async (req: Request) => {
     try {
          const reqBody = await req.json();

          const parseBody = safeValidateBody(reqBody);
          if (!parseBody.success) {
               return Response.json({ message: "Invalid request body", error: parseBody.error }, { status: 400 });
          }

          const body = parseBody.data as Body;
          const { message } = body;

          if (message.content === "") {
               return Response.json(
                    {
                         message: "Please provide a message to process",
                    },
                    { status: 400 }
               );
          }

          // Load the chat model
          const provider = modelRegistry.getProviderById(body.chatModel.providerId);
          if (!provider) {
               return Response.json(
                    {
                         message: `Provider ${body.chatModel.providerId} not found`,
                    },
                    { status: 400 }
               );
          }

          const llm = (await provider.provider.loadChatModel(body.chatModel.key)) as BaseChatModel;

          const humanMessageId = message.messageId ?? crypto.randomBytes(7).toString("hex");

          const history: BaseMessage[] = body.history.map((msg) => {
               if (msg[0] === "human") {
                    return new HumanMessage({
                         content: msg[1],
                    });
               } else {
                    return new AIMessage({
                         content: msg[1],
                    });
               }
          });

          // Determine folder names to search
          // If not provided, use all registered folders
          const folderNames = body.folderNames ?? getAllFolderNames();

          // Get the appropriate search agent
          const agent = getSearchAgent(body.focusMode);

          // Call searchAndAnswer with the new signature
          const stream = await agent.searchAndAnswer(
               message.content,
               history,
               llm,
               body.systemInstructions as string,
               [folderNames] // searchRetrieverChainArgs - folderNames for CodeSearchAgent
          );

          const responseStream = new TransformStream();
          const writer = responseStream.writable.getWriter();
          const encoder = new TextEncoder();

          handleEmitterEvents(stream, writer, encoder, message.chatId);
          handleHistorySave(message, humanMessageId, body.files);

          return new Response(responseStream.readable, {
               headers: {
                    "Content-Type": "text/event-stream",
                    Connection: "keep-alive",
                    "Cache-Control": "no-cache, no-transform",
               },
          });
     } catch (err) {
          console.error("An error occurred while processing chat request:", err);
          return Response.json({ message: "An error occurred while processing chat request" }, { status: 500 });
     }
};
