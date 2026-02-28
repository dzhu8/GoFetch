import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { AcademicSearchChunk } from "./types";
import { academicFilterPrompt } from "@/lib/prompts/academicSearch";

/**
 * Uses the LLM as a judge to filter out irrelevant academic search results
 * based on their title and abstract.
 */
export async function filterRelevantChunks(
     query: string,
     chunks: AcademicSearchChunk[],
     llm: BaseChatModel
): Promise<AcademicSearchChunk[]> {
     if (chunks.length === 0) return [];

     // Prepare a compact list of documents for the models context
     const docsContext = chunks
          .map((c, i) => `[${i}]\nTitle: ${c.metadata.title}\nAbstract: ${c.content}`)
          .join("\n\n");

     try {
          const res = await llm.invoke([
               new SystemMessage(academicFilterPrompt),
               new HumanMessage(`Query: ${query}\n\nSearch Results for Evaluation:\n${docsContext}`)
          ]);

          let text = res.content as string;
          // Strip out markdown code blocks if the model wrapped the JSON array in them
          text = text.replace(/```json/gi, "").replace(/```/g, "").trim();

          const indices = JSON.parse(text);

          console.log(`[academicSearch] Filtered ${chunks.length} results down to ${Array.isArray(indices) ? indices.length : "invalid"} relevant sources.`);

          if (!Array.isArray(indices)) {
               console.warn("[academicSearch] Filter did not return an array. Falling back to all chunks.");
               return chunks;
          }

          const filteredChunks = indices
               .map(i => chunks[i])
               .filter(Boolean); // Drop nulls if model hallucinated indices out of bounds

          // If the model filtered everything, it might be overly strict. 
          // We can return the empty list so the AI can answer "I couldn't find any relevant sources" 
          // rather than hallucinate using irrelevant data.
          return filteredChunks;
     } catch (err) {
          console.error("[academicSearch] Error filtering chunks, using original set:", err);
          return chunks;
     }
}