"use server";

import configManager from "@/server";
import ModelRegistry from "@/server/providerRegistry";
import { ConfigModelProvider } from "@/lib/models/types";

export async function getConfig() {
     try {
          const values = configManager.getAllConfig();
          const fields = configManager.getUIConfigSections();

          const modelProviders = await ModelRegistry.getActiveProviders();

          values.modelProviders = values.modelProviders.map((mp: ConfigModelProvider) => {
               const activeProvider = modelProviders.find((p) => p.id === mp.id);

               return {
                    ...mp,
                    chatModels: activeProvider?.chatModels ?? mp.chatModels,
                    embeddingModels: activeProvider?.embeddingModels ?? mp.embeddingModels,
               };
          });

          return {
               values,
               fields,
          };
     } catch (err) {
          console.error("Error in getting config: ", err);
          return { error: "An error has occurred." };
     }
}

export async function updateConfig(key: string, value: string) {
     try {
          if (!key || !value) {
               return { error: "Key and value are required." };
          }

          configManager.updateConfig(key, value);

          return { message: "Config updated successfully." };
     } catch (err) {
          console.error("Error in getting config: ", err);
          return { error: "An error has occurred." };
     }
}

export async function markSetupComplete() {
     try {
          configManager.markSetupComplete();

          return { message: "Setup marked as complete." };
     } catch (err) {
          console.error("Error marking setup as complete: ", err);
          return { error: "An error has occurred." };
     }
}
