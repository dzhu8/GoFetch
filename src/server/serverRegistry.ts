import configManager from "./index";
import { ConfigModelProvider } from "@/lib/models/types";

export const getConfiguredModelProviders = (): ConfigModelProvider[] => {
     return configManager.getModelProviders();
};

export const getSearxngURL = (): string =>
     process.env.SEARXNG_API_URL || configManager.getConfig("search.searxngURL", "http://localhost:8080");

export const getConfiguredModelProviderById = (id: string): ConfigModelProvider | undefined => {
     return getConfiguredModelProviders().find((p) => p.id === id) ?? undefined;
};

export const setConfiguredModelProviders = (providers: ConfigModelProvider[]): void => {
     configManager.setModelProviders(providers);
};
