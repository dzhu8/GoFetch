import configManager from "./index";
import { ConfigModelProvider } from "@/lib/models/types";

export const getConfiguredModelProviders = (): ConfigModelProvider[] => {
     return configManager.getModelProviders();
};

export const getConfiguredModelProviderById = (id: string): ConfigModelProvider | undefined => {
     return getConfiguredModelProviders().find((p) => p.id === id) ?? undefined;
};

export const setConfiguredModelProviders = (providers: ConfigModelProvider[]): void => {
     configManager.setModelProviders(providers);
};
