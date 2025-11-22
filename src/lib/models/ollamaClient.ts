export interface OllamaTagDetails {
     format?: string;
     family?: string;
     families?: string[];
     parameter_size?: string; // e.g. "7B"
     quantization_level?: string; // e.g. "Q4_K_M"
}

export interface OllamaTag {
     name: string; // model name, e.g. "llama3.2"
     modified_at: string;
     size: number; // bytes
     digest: string;
     details?: OllamaTagDetails;
}

export interface OllamaTagsResponse {
     models: OllamaTag[];
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export async function listOllamaModels(): Promise<OllamaTag[]> {
     const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
          method: "GET",
     });

     if (!res.ok) {
          throw new Error(`Failed to list Ollama models: ${res.status} ${res.statusText}`);
     }

     const data = (await res.json()) as OllamaTagsResponse;
     return data.models ?? [];
}
