"use client";

import { updateConfig } from "@/lib/actions/config";

export type ModelPreference = {
     providerId: string;
     modelKey: string;
};

type ModelPreferenceKind = "chat" | "embedding" | "ocr";

const CONFIG_KEYS: Record<ModelPreferenceKind, string> = {
     chat: "preferences.defaultChatModel",
     embedding: "preferences.defaultEmbeddingModel",
     ocr: "preferences.defaultOCRModel",
};

export const persistModelPreference = async (kind: ModelPreferenceKind, preference: ModelPreference) => {
     const result = await updateConfig(CONFIG_KEYS[kind], preference);

     if (result.error) {
          throw new Error(result.error || "Failed to save configuration");
     }
};
