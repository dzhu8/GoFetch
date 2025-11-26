import { Message } from "@/components/ChatWindow";

export const getSuggestions = async (
     chatHistory: Message[],
     chatModel: { providerId: string; key: string }
) => {
     if (!chatModel.providerId || !chatModel.key) {
          return [];
     }

     const res = await fetch(`/api/suggestions`, {
          method: "POST",
          headers: {
               "Content-Type": "application/json",
          },
          body: JSON.stringify({
               chatHistory: chatHistory,
               chatModel,
          }),
     });

     const data = (await res.json()) as { suggestions: string[] };

     return data.suggestions;
};
