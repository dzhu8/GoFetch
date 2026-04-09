import { ConfigModelProvider, Model, ModelList } from "@/lib/models/types";
import { BaseModelProvider } from "./BaseModelProvider";

/**
 * Known models available through GitHub Copilot.
 * The actual list depends on the user's GitHub plan; these are reasonable
 * defaults that can be overridden via the provider config.
 */
const DEFAULT_CHAT_MODELS: Model[] = [
     // ── Anthropic ──────────────────────────────────────────────────────────
     { key: "claude-sonnet-4.6",  name: "Claude Sonnet 4.6" },
     { key: "claude-sonnet-4.5",  name: "Claude Sonnet 4.5" },
     { key: "claude-sonnet-4",    name: "Claude Sonnet 4" },
     { key: "claude-opus-4.6",    name: "Claude Opus 4.6" },
     { key: "claude-opus-4.5",    name: "Claude Opus 4.5" },
     { key: "claude-haiku-4.5",   name: "Claude Haiku 4.5" },
     // ── OpenAI ─────────────────────────────────────────────────────────────
     { key: "gpt-5.4",            name: "GPT-5.4" },
     { key: "gpt-5.4-mini",       name: "GPT-5.4 mini" },
     { key: "gpt-5.3-codex",      name: "GPT-5.3-Codex" },
     { key: "gpt-5.2-codex",      name: "GPT-5.2-Codex" },
     { key: "gpt-5.2",            name: "GPT-5.2" },
     { key: "gpt-5.1",            name: "GPT-5.1" },
     { key: "gpt-5-mini",         name: "GPT-5 mini" },
     { key: "gpt-4.1",            name: "GPT-4.1" },
];

export class CopilotProvider extends BaseModelProvider<never, never> {
     constructor(definition: ConfigModelProvider) {
          super(definition);
     }

     getAvailableChatModels(): Model[] {
          return this.definition.chatModels?.length
               ? this.definition.chatModels
               : DEFAULT_CHAT_MODELS;
     }

     getAvailableEmbeddingModels(): Model[] {
          return [];
     }

     getAvailableOCRModels(): Model[] {
          return [];
     }

     /**
      * Not used — the chat route bypasses the model registry for Copilot
      * and delegates to `handleCopilotChat()` in `src/lib/copilot/bridge.ts`.
      * The selected model key is forwarded to the Copilot CLI via `--model`.
      */
     async loadChatModel(_modelKey: string): Promise<never> {
          throw new Error(
               "CopilotProvider.loadChatModel() should not be called directly. " +
               "The chat route delegates to the Copilot bridge instead.",
          );
     }

     async loadEmbeddingModel(_modelKey: string): Promise<never> {
          throw new Error("Copilot does not provide embedding models.");
     }

     async loadOCRModel(_modelKey: string): Promise<never> {
          throw new Error("Copilot does not provide OCR models.");
     }

     async getModelList(): Promise<ModelList> {
          return {
               chat: this.getAvailableChatModels(),
               embedding: [],
               ocr: [],
          };
     }
}
