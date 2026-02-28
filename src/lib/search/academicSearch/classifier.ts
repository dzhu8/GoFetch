import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage, HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { academicClassifierPrompt } from "@/lib/prompts/academicSearch";
import { ClassifierOutput } from "./types";

/**
 * Converts the conversation history to a plain text string for the classifier prompt.
 */
function formatHistory(history: Array<[string, string]>): string {
     if (history.length === 0) return "(no prior conversation)";
     return history
          .map(([role, content]) => `${role === "human" ? "User" : "Assistant"}: ${content}`)
          .join("\n");
}

/**
 * Attempts to extract JSON from an LLM response that may include markdown fences.
 */
function extractJSON(text: string): any {
     const jsonMatch = text.match(/\{[\s\S]*\}/);
     if (!jsonMatch) throw new Error("No JSON found in classifier response");
     return JSON.parse(jsonMatch[0]);
}

/**
 * Classifies the user's academic search query:
 * - Produces a self-contained standalone query
 * - Generates up to 3 targeted search queries for academic databases
 */
export async function classifyAcademicQuery(
     query: string,
     history: Array<[string, string]>,
     llm: BaseChatModel,
): Promise<ClassifierOutput> {
     const historyText = formatHistory(history.slice(-6));

     const messages: BaseMessage[] = [
          new SystemMessage(academicClassifierPrompt),
          new HumanMessage(
               `<conversation_history>\n${historyText}\n</conversation_history>\n<user_query>\n${query}\n</user_query>`,
          ),
     ];

     const response = await llm.invoke(messages);
     const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

     try {
          const parsed = extractJSON(content);
          return {
               standaloneQuery: String(parsed.standaloneQuery ?? query),
               searchQueries: Array.isArray(parsed.searchQueries)
                    ? (parsed.searchQueries as string[]).slice(0, 3)
                    : [query],
          };
     } catch {
          // Fallback: use the original query as both standalone and search query
          return {
               standaloneQuery: query,
               searchQueries: [query],
          };
     }
}
