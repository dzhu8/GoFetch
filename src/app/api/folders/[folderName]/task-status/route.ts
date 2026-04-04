import { getTaskProgress, taskProgressEmitter } from "@/lib/embed/progress";
import type { TaskProgressState } from "@/lib/embed/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ folderName: string }> }) {
     const { folderName } = await params;
     const decoded = decodeURIComponent(folderName);

     const stream = new ReadableStream({
          start(controller) {
               const encoder = new TextEncoder();
               const send = (state: TaskProgressState) => {
                    try {
                         controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
                    } catch {
                         // Stream closed — clean up below
                    }
               };

               // Send current state immediately so the client is up-to-date.
               send(getTaskProgress(decoded));

               const onUpdate = (state: TaskProgressState) => {
                    if (state.folderName === decoded) send(state);
               };

               const onClear = ({ folderName: cleared }: { folderName: string }) => {
                    if (cleared === decoded) {
                         send({ ...getTaskProgress(decoded), phase: "completed" });
                    }
               };

               taskProgressEmitter.on("update", onUpdate);
               taskProgressEmitter.on("clear", onClear);

               // Heartbeat to keep the connection alive
               const heartbeat = setInterval(() => {
                    try {
                         controller.enqueue(encoder.encode(": heartbeat\n\n"));
                    } catch {
                         clearInterval(heartbeat);
                    }
               }, 15_000);

               // Clean up when the client disconnects
               const cleanup = () => {
                    clearInterval(heartbeat);
                    taskProgressEmitter.off("update", onUpdate);
                    taskProgressEmitter.off("clear", onClear);
               };

               // ReadableStream cancel is called when the client closes the connection
               controller.close = new Proxy(controller.close, {
                    apply(target, thisArg) {
                         cleanup();
                         return Reflect.apply(target, thisArg, []);
                    },
               });

               // Also handle abort via the request signal if available
               _req.signal?.addEventListener("abort", cleanup, { once: true });
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
