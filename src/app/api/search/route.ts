import { z } from "zod";
import { getHNSWSearch } from "@/lib/search";
import { embedQuery } from "@/lib/search/embedding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const searchSchema = z.object({
     query: z.string().min(1),
     k: z.number().optional().default(10),
     folderNames: z.array(z.string()).optional(),
     threshold: z.number().optional(),
});

export async function POST(req: Request) {
     try {
          const body = await req.json();
          const result = searchSchema.safeParse(body);

          if (!result.success) {
               return Response.json({ error: result.error }, { status: 400 });
          }

          const { query, k, folderNames, threshold } = result.data;

          // 1. Embed the query
          const queryVector = await embedQuery(query);

          // 2. Initialize Search
          const HNSWSearch = getHNSWSearch();
          const hnswSearch = HNSWSearch.fromConfig();

          // 3. Add folders
          if (folderNames && folderNames.length > 0) {
               await hnswSearch.addFolders(folderNames);
          } else {
               await hnswSearch.addAllFolders();
          }

          // 4. Search
          let searchResults;
          if (threshold !== undefined) {
               if (folderNames && folderNames.length > 0) {
                    searchResults = await hnswSearch.searchInFoldersWithThreshold(
                         queryVector,
                         folderNames,
                         k,
                         threshold
                    );
               } else {
                    searchResults = await hnswSearch.searchWithThreshold(queryVector, k, threshold);
               }
          } else {
               if (folderNames && folderNames.length > 0) {
                    searchResults = await hnswSearch.searchInFolders(queryVector, folderNames, k);
               } else {
                    searchResults = await hnswSearch.search(queryVector, k);
               }
          }

          return Response.json({ results: searchResults });
     } catch (error) {
          console.error("Search API error:", error);
          return Response.json({ error: "Internal server error" }, { status: 500 });
     }
}
