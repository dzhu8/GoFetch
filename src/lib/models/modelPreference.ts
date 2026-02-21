"use client";

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
     const res = await fetch("/api/config", {
          method: "POST",
          headers: {
               "Content-Type": "application/json",
          },
          body: JSON.stringify({
               key: CONFIG_KEYS[kind],
               value: preference,
          }),
     });

     if (!res.ok) {
          const message = await res.text();
          throw new Error(message || "Failed to save configuration");
     }
};
