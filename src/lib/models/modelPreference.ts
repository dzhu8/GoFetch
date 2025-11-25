"use client";

export type ModelPreference = {
     providerId: string;
     modelKey: string;
};

type ModelPreferenceKind = "chat" | "embedding";

const CONFIG_KEYS: Record<ModelPreferenceKind, string> = {
     chat: "preferences.defaultChatModel",
     embedding: "preferences.defaultEmbeddingModel",
};

const STORAGE_KEYS: Record<ModelPreferenceKind, { providerId: string; modelKey: string }> = {
     chat: {
          providerId: "chatModelProviderId",
          modelKey: "chatModelKey",
     },
     embedding: {
          providerId: "embeddingModelProviderId",
          modelKey: "embeddingModelKey",
     },
};

export const persistModelPreference = async (kind: ModelPreferenceKind, preference: ModelPreference) => {
     if (typeof window !== "undefined") {
          localStorage.setItem(STORAGE_KEYS[kind].providerId, preference.providerId);
          localStorage.setItem(STORAGE_KEYS[kind].modelKey, preference.modelKey);
     }

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
