"use client";

import { useEffect, useMemo, useState } from "react";
import Select from "../Select";
import { ConfigModelProvider } from "@/lib/models/types";
import { ModelPreference, persistModelPreference } from "@/lib/models/modelPreference";
import { toast } from "sonner";
import { useChat } from "@/lib/chat/Chat";

export type SettingsDropdownProps = {
     label: string;
     description: string;
     type: "chat" | "embedding";
     providers: ConfigModelProvider[];
     value?: ModelPreference | null;
     onChange?: (preference: ModelPreference) => void;
};

const SettingsDropdown = ({ label, description, type, providers, value, onChange }: SettingsDropdownProps) => {
     const deriveLocalValue = () => {
          if (value?.providerId && value?.modelKey) {
               return `${value.providerId}/${value.modelKey}`;
          }

          if (typeof window === "undefined") return "";

          const providerKey = type === "chat" ? "chatModelProviderId" : "embeddingModelProviderId";
          const modelKey = type === "chat" ? "chatModelKey" : "embeddingModelKey";

          const storedProvider = localStorage.getItem(providerKey) ?? "";
          const storedModel = localStorage.getItem(modelKey) ?? "";

          return storedProvider && storedModel ? `${storedProvider}/${storedModel}` : "";
     };

     const [selectedModel, setSelectedModel] = useState<string>(deriveLocalValue);
     const [loading, setLoading] = useState(false);
     const { setChatModelProvider, setEmbeddingModelProvider } = useChat();

     useEffect(() => {
          if (value?.providerId && value?.modelKey) {
               const serialized = `${value.providerId}/${value.modelKey}`;
               setSelectedModel(serialized);
          }
     }, [value?.providerId, value?.modelKey]);

     const options = useMemo(() => {
          if (type === "chat") {
               return providers.flatMap((provider) =>
                    provider.chatModels.map((model) => ({
                         value: `${provider.id}/${model.key}`,
                         label: `${provider.name} - ${model.name}`,
                    }))
               );
          }

          return providers.flatMap((provider) =>
               provider.embeddingModels.map((model) => ({
                    value: `${provider.id}/${model.key}`,
                    label: `${provider.name} - ${model.name}`,
               }))
          );
     }, [providers, type]);

     const handleSave = async (newValue: string) => {
          setLoading(true);

          try {
               const [providerId, ...modelParts] = newValue.split("/");
               const modelKey = modelParts.join("/");

               if (!providerId || !modelKey) {
                    throw new Error("Invalid model selection");
               }

               await persistModelPreference(type, { providerId, modelKey });

               if (type === "chat") {
                    setChatModelProvider({ providerId, key: modelKey });
               } else {
                    setEmbeddingModelProvider({ providerId, key: modelKey });
               }

               setSelectedModel(newValue);
               onChange?.({ providerId, modelKey });
          } catch (error) {
               console.error("Error saving config:", error);
               toast.error("Failed to save configuration.");
          } finally {
               setLoading(false);
          }
     };

     return (
          <section className="rounded-xl border border-light-200 bg-light-primary/80 p-4 lg:p-6 transition-colors dark:border-dark-200 dark:bg-dark-primary/80">
               <div className="space-y-3 lg:space-y-5">
                    <div>
                         <h4 className="text-sm lg:text-sm text-black dark:text-white">{label}</h4>
                         <p className="text-[11px] lg:text-xs text-black/50 dark:text-white/50">{description}</p>
                    </div>
                    <Select
                         value={selectedModel}
                         onChange={(event) => handleSave(event.target.value)}
                         options={options}
                         className="!text-xs lg:!text-sm"
                         loading={loading}
                         disabled={loading || options.length === 0}
                    />
                    {options.length === 0 && (
                         <p className="text-[11px] text-black/50 dark:text-white/50">
                              No {type} models available. Configure a provider first.
                         </p>
                    )}
               </div>
          </section>
     );
};

export default SettingsDropdown;
