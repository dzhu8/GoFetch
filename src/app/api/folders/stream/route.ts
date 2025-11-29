import { NextRequest } from "next/server";
import folderRegistry from "@/server/folderRegistry";
import folderEvents from "@/server/folderEvents";
import db from "@/server/db";
import { embeddings } from "@/server/db/schema";
import { count } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getFoldersWithCounts() {
     const folders = folderRegistry.getFolders();

     const embeddingCounts = db
          .select({
               folderName: embeddings.folderName,
               count: count(),
          })
          .from(embeddings)
          .groupBy(embeddings.folderName)
          .all();

     const countsMap = new Map(embeddingCounts.map((e) => [e.folderName, e.count]));

     return folders.map((folder) => ({
          ...folder,
          embeddingCount: countsMap.get(folder.name) || 0,
     }));
}

export async function GET(req: NextRequest) {
     const encoder = new TextEncoder();

     const stream = new ReadableStream({
          start(controller) {
               // Send initial data immediately
               const initialData = JSON.stringify({ folders: getFoldersWithCounts() });
               controller.enqueue(encoder.encode(`data: ${initialData}\n\n`));

               // Listen for folder changes
               const onChange = () => {
                    try {
                         const data = JSON.stringify({ folders: getFoldersWithCounts() });
                         controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                    } catch (error) {
                         console.error("[SSE] Error sending folder update:", error);
                    }
               };

               folderEvents.on("change", onChange);

               // Send periodic heartbeat to keep connection alive (every 30s)
               const heartbeatInterval = setInterval(() => {
                    try {
                         controller.enqueue(encoder.encode(`: heartbeat\n\n`));
                    } catch {
                         // Connection closed, cleanup will happen in cancel
                    }
               }, 30000);

               // Cleanup when client disconnects
               req.signal.addEventListener("abort", () => {
                    folderEvents.off("change", onChange);
                    clearInterval(heartbeatInterval);
                    try {
                         controller.close();
                    } catch {
                         // Already closed
                    }
               });
          },
          cancel() {
               // Stream cancelled by client
          },
     });

     return new Response(stream, {
          headers: {
               "Content-Type": "text/event-stream",
               "Cache-Control": "no-cache, no-transform",
               Connection: "keep-alive",
               "X-Accel-Buffering": "no", // Disable nginx buffering
          },
     });
}
