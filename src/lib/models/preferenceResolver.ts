import type { MinimalProvider, Model } from "@/lib/models/types";
import type { ModelPreference } from "@/lib/models/modelPreference";

type PreferenceKind = "chat" | "embedding";

const MODEL_FIELD: Record<PreferenceKind, "chatModels" | "embeddingModels"> = {
     chat: "chatModels",
     embedding: "embeddingModels",
};

const HUMAN_LABEL: Record<PreferenceKind, string> = {
     chat: "chat",
     embedding: "embedding",
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
