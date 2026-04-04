"use server";

import { Message } from "@/components/ChatWindow";
import modelRegistry from "@/server/providerRegistry";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";

const SUGGESTIONS_PROMPT = `Based on the chat history above, generate exactly 3 short, relevant follow-up questions or suggestions for the user. 
The suggestions should help the user explore the topic deeper or refine their research.
Format the output as a simple list of 3 strings, one per line. Do not include numbers or bullet points.`;

export const getSuggestions = async (chatHistory: Message[], chatModel: { providerId: string; key: string }) => {
     if (!chatModel.providerId || !chatModel.key) {
          return [];
     }

     try {
          const model: BaseChatModel | null = await modelRegistry.getModel(chatModel.providerId, chatModel.key);
          if (!model) {
               return [];
          }

          const history = chatHistory
               .map((m) => {
                    if (m.role === "user") return new HumanMessage(m.content);
                    if (m.role === "assistant") return new AIMessage(m.content);
                    return null;
               })
               .filter((m): m is HumanMessage | AIMessage => m !== null);

          // Only keep last few turns for context if too long
          const slicedHistory = history.slice(-6);

          const response = await model.invoke([...slicedHistory, new HumanMessage(SUGGESTIONS_PROMPT)]);

          const content = typeof response.content === "string" ? response.content : "";
          const suggestions = content
               .split("\n")
               .map((s: string) => s.trim())
               .filter((s: string) => s.length > 0 && !s.startsWith("-") && !s.match(/^\d\./))
               .slice(0, 3);

          return suggestions;
     } catch (err) {
          console.error("[Suggestions] Error:", err);
          return [];
     }
};
