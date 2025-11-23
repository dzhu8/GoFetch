import { NextRequest, NextResponse } from "next/server";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const normalizeBaseUrl = (url?: string) => {
     const value = (url ?? DEFAULT_OLLAMA_BASE_URL).trim();
     return value.replace(/\/$/, "");
};

export async function POST(req: NextRequest) {
     try {
          const { modelName, baseURL } = await req.json();

          if (!modelName || typeof modelName !== "string") {
               return NextResponse.json({ error: "modelName is required" }, { status: 400 });
          }

          const upstream = await fetch(`${normalizeBaseUrl(baseURL)}/api/pull`, {
               method: "POST",
               headers: {
                    "Content-Type": "application/json",
               },
               body: JSON.stringify({
                    name: modelName,
                    stream: true,
               }),
          });

          if (!upstream.body) {
               const text = await upstream.text();
               throw new Error(text || "Upstream download failed");
          }

          const proxyStream = new ReadableStream<Uint8Array>({
               async start(controller) {
                    const reader = upstream.body!.getReader();
                    try {
                         while (true) {
                              const { done, value } = await reader.read();
                              if (done) break;
                              if (value) controller.enqueue(value);
                         }
                         controller.close();
                    } catch (err) {
                         controller.error(err);
                    } finally {
                         reader.releaseLock();
                    }
               },
          });

          return new NextResponse(proxyStream, {
               headers: {
                    "Content-Type": "application/json",
               },
               status: upstream.ok ? 200 : upstream.status,
          });
     } catch (error) {
          console.error("Error downloading Ollama model:", error);
          return NextResponse.json(
               { error: error instanceof Error ? error.message : "Failed to download model" },
               { status: 500 }
          );
     }
}
