"use server";

import db from "@/server/db";
import { chats, messages } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export async function getChats() {
     try {
          let chatList = await db.query.chats.findMany();
          chatList = chatList.reverse();
          return { chats: chatList };
     } catch (err) {
          console.error("Error in getting chats: ", err);
          return { error: "An error has occurred." };
     }
}

export async function getChat(id: string) {
     try {
          const chatExists = await db.query.chats.findFirst({
               where: eq(chats.id, id),
          });

          if (!chatExists) {
               return { error: "Chat not found" };
          }

          const chatMessages = await db.query.messages.findMany({
               where: eq(messages.chatId, id),
          });

          return {
               chat: chatExists,
               messages: chatMessages,
          };
     } catch (err) {
          console.error("Error in getting chat by id: ", err);
          return { error: "An error has occurred." };
     }
}

export async function deleteChat(id: string) {
     try {
          const chatExists = await db.query.chats.findFirst({
               where: eq(chats.id, id),
          });

          if (!chatExists) {
               return { error: "Chat not found" };
          }

          await db.delete(chats).where(eq(chats.id, id)).execute();
          await db.delete(messages).where(eq(messages.chatId, id)).execute();

          return { message: "Chat deleted successfully" };
     } catch (err) {
          console.error("Error in deleting chat by id: ", err);
          return { error: "An error has occurred." };
     }
}
