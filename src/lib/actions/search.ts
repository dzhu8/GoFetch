"use server";

import { z } from "zod";
import { getHNSWSearch } from "@/lib/search";
import { embedQuery } from "@/lib/search/embedding";

const searchSchema = z.object({
     query: z.string().min(1),
     k: z.number().optional().default(10),
     folderNames: z.array(z.string()).optional(),
     threshold: z.number().optional(),
});

export async function searchEmbeddings(
     query: string,
     k?: number,
     folderNames?: string[],
     threshold?: number
) {
     try {
          const result = searchSchema.safeParse({
               query,
               k: k ?? 10,
               folderNames,
               threshold,
          });

          if (!result.success) {
               return { error: result.error };
          }

          const {
               query: validatedQuery,
               k: validatedK,
               folderNames: validatedFolderNames,
               threshold: validatedThreshold,
          } = result.data;

          // 1. Embed the query
          const queryVector = await embedQuery(validatedQuery);

          // 2. Initialize Search
          const HNSWSearch = getHNSWSearch();
          const hnswSearch = HNSWSearch.fromConfig();

          // 3. Add folders
          if (validatedFolderNames && validatedFolderNames.length > 0) {
               await hnswSearch.addFolders(validatedFolderNames);
          } else {
               await hnswSearch.addAllFolders();
          }

          // 4. Search
          let searchResults;
          if (validatedThreshold !== undefined) {
               if (validatedFolderNames && validatedFolderNames.length > 0) {
                    searchResults = await hnswSearch.searchInFoldersWithThreshold(
                         queryVector,
                         validatedFolderNames,
                         validatedK,
                         validatedThreshold
                    );
               } else {
                    searchResults = await hnswSearch.searchWithThreshold(queryVector, validatedK, validatedThreshold);
               }
          } else {
               if (validatedFolderNames && validatedFolderNames.length > 0) {
                    searchResults = await hnswSearch.searchInFolders(queryVector, validatedFolderNames, validatedK);
               } else {
                    searchResults = await hnswSearch.search(queryVector, validatedK);
               }
          }

          return { results: searchResults };
     } catch (error) {
          console.error("Search API error:", error);
          return { error: "Internal server error" };
     }
}
