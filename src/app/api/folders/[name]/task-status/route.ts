import { NextRequest, NextResponse } from "next/server";

import { taskProgressEmitter, getTaskProgress } from "@/lib/embed/progress";
import type { TaskProgressState } from "@/lib/embed/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
     const { name } = await params;
     const folderName = decodeURIComponent(name ?? "").trim();

     if (!folderName) {
          return NextResponse.json({ error: "Folder name is required." }, { status: 400 });
     }

     const encoder = new TextEncoder();
     const stream = new ReadableStream({
          start(controller) {
               let closed = false;

               const cleanup = () => {
                    if (closed) return;
                    closed = true;
                    taskProgressEmitter.off("update", onUpdate);
                    taskProgressEmitter.off("clear", onClear);
               };

               // Send initial state immediately
               const initialProgress = getTaskProgress(folderName);
               controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialProgress)}\n\n`));

               // Listen for updates — never close the stream server-side;
               // the client manages the EventSource lifecycle.
               const onUpdate = (progress: TaskProgressState) => {
                    if (closed || progress.folderName !== folderName) return;
                    try {
                         controller.enqueue(encoder.encode(`data: ${JSON.stringify(progress)}\n\n`));
                    } catch {
                         cleanup();
                    }
               };

               const onClear = ({ folderName: cleared }: { folderName: string }) => {
                    if (closed || cleared !== folderName) return;
                    cleanup();
                    try { controller.close(); } catch { /* already closed */ }
               };

               taskProgressEmitter.on("update", onUpdate);
               taskProgressEmitter.on("clear", onClear);

               // Cleanup when client disconnects
               _req.signal.addEventListener("abort", cleanup);
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
