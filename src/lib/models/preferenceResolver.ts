import type { MinimalProvider, Model } from "@/lib/models/types";
import type { ModelPreference } from "@/lib/models/modelPreference";

type PreferenceKind = "chat" | "embedding" | "ocr";

const MODEL_FIELD: Record<PreferenceKind, "chatModels" | "embeddingModels" | "ocrModels"> = {
     chat: "chatModels",
     embedding: "embeddingModels",
     ocr: "ocrModels",
};

const HUMAN_LABEL: Record<PreferenceKind, string> = {
     chat: "chat",
     embedding: "embedding",
     ocr: "OCR",
};

export function resolveModelPreference(
     kind: PreferenceKind,
     providers: MinimalProvider[],
     configuredPreference: ModelPreference | null | undefined
): ModelPreference {
     const field = MODEL_FIELD[kind];
     const label = HUMAN_LABEL[kind];

     if (!Array.isArray(providers) || providers.length === 0) {
          throw new Error(`No ${label} model providers found, please configure them in the settings page.`);
     }

     const provider =
          (configuredPreference?.providerId &&
               providers.find(
                    (candidate) => candidate.id === configuredPreference.providerId && hasModels(candidate[field])
               )) ||
          providers.find((candidate) => hasModels(candidate[field]));

     if (!provider) {
          throw new Error(`No ${label} models found, please configure them in the settings page.`);
     }

     const models = provider[field];

     const model =
          (configuredPreference?.modelKey &&
               models.find((candidate: Model) => candidate.key === configuredPreference.modelKey)) ||
          models[0];

     if (!model) {
          throw new Error(`Provider ${provider.name} has no ${label} models configured.`);
     }

     return {
          providerId: provider.id,
          modelKey: model.key,
     };
}

function hasModels(models?: Model[]): models is Model[] {
     return Array.isArray(models) && models.length > 0;
}

/** Resolves an OCR model preference without throwing — returns null if none configured. */
export function resolveOcrModelPreference(
     providers: MinimalProvider[],
     configuredPreference: ModelPreference | null | undefined
): ModelPreference | null {
     const provider =
          (configuredPreference?.providerId &&
               providers.find(
                    (candidate) => candidate.id === configuredPreference.providerId && hasModels(candidate.ocrModels)
               )) ||
          providers.find((candidate) => hasModels(candidate.ocrModels));

     if (!provider) return null;

     const model =
          (configuredPreference?.modelKey &&
               provider.ocrModels.find((candidate: Model) => candidate.key === configuredPreference.modelKey)) ||
          provider.ocrModels[0];

     if (!model) return null;

     return { providerId: provider.id, modelKey: model.key };
}
