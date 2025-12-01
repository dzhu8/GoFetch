import { NextRequest, NextResponse } from "next/server";

import { embeddingProgressEmitter, getEmbeddingProgress } from "@/lib/embed/progress";
import type { EmbeddingProgressState } from "@/lib/embed/types";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
     const { name } = await params;
     const folderName = decodeURIComponent(name ?? "").trim();

     if (!folderName) {
          return NextResponse.json({ error: "Folder name is required." }, { status: 400 });
     }

     const encoder = new TextEncoder();
     const stream = new ReadableStream({
          start(controller) {
               // Send initial state immediately
               const initialProgress = getEmbeddingProgress(folderName);
               controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialProgress)}\n\n`));

               // Listen for updates
               const onUpdate = (progress: EmbeddingProgressState) => {
                    if (progress.folderName === folderName) {
                         controller.enqueue(encoder.encode(`data: ${JSON.stringify(progress)}\n\n`));

                         // Close stream when embedding is complete or errored
                         if (progress.phase === "completed" || progress.phase === "error") {
                              controller.close();
                         }
                    }
               };

               const onClear = ({ folderName: cleared }: { folderName: string }) => {
                    if (cleared === folderName) {
                         controller.close();
                    }
               };

               embeddingProgressEmitter.on("update", onUpdate);
               embeddingProgressEmitter.on("clear", onClear);

               // Cleanup when client disconnects
               _req.signal.addEventListener("abort", () => {
                    embeddingProgressEmitter.off("update", onUpdate);
                    embeddingProgressEmitter.off("clear", onClear);
               });
          },
     });

     return new Response(stream, {
          headers: {
               "Content-Type": "text/event-stream",
               "Cache-Control": "no-cache, no-transform",
               Connection: "keep-alive",
          },
     });
}
