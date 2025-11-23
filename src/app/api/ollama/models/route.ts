import { NextRequest, NextResponse } from "next/server";
import { inferOllamaFamilyFromName, isRecommendedOllamaModel } from "@/lib/models/providers/OllamaProvider";

const formatSize = (bytes: number): string => {
     if (!bytes || bytes === 0) return "0 GB";
     const gb = bytes / 1024 ** 3;
     return gb.toFixed(1) + " GB";
};

export async function GET(req: NextRequest) {
     const { searchParams } = new URL(req.url);
     const baseURL = searchParams.get("baseURL")?.trim() || "http://127.0.0.1:11434";

     try {
          const res = await fetch(`${baseURL}/api/tags`, {
               headers: {
                    "Content-Type": "application/json",
               },
          });

          if (!res.ok) {
               throw new Error(`Ollama API responded with status ${res.status}: ${res.statusText}`);
          }

          const data = await res.json();

          if (!data.models || !Array.isArray(data.models)) {
               throw new Error("Invalid response from Ollama API");
          }

          const models = data.models.map((model: any) => ({
               name: model.name || "Unknown",
               size: formatSize(model.size || 0),
               description: model.details?.description || `${model.name} model`,
               installed: true, // Models listed are installed
               recommended: isRecommendedOllamaModel(model.name || ""),
               family: model.details?.family
                    ? inferOllamaFamilyFromName(model.details.family)
                    : inferOllamaFamilyFromName(model.name || ""),
          }));

          return NextResponse.json({ models });
     } catch (error) {
          console.error("Error fetching Ollama models:", error);
          return NextResponse.json(
               { error: error instanceof Error ? error.message : "Failed to fetch models" },
               { status: 500 }
          );
     }
}
