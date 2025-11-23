"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Loader2, PlugZap, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfigModelProvider } from "@/lib/models/types";
import { UIConfigSections } from "@/lib/config/types";
import OllamaModels from "./modelsView/OllamaModels";
import AddProvider from "../models/AddProvider";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SetupConfigProps = {
     configSections: UIConfigSections;
     setupState: number;
     setSetupState: (state: number) => void;
};

const SetupConfig = ({ configSections, setupState, setSetupState }: SetupConfigProps) => {
     const [providers, setProviders] = useState<ConfigModelProvider[]>([]);
     const [isLoading, setIsLoading] = useState(true);
     const [isFinishing, setIsFinishing] = useState(false);
     const [isAddProviderOpen, setIsAddProviderOpen] = useState(false);

     const fetchProviders = useCallback(async () => {
          try {
               setIsLoading(true);
               const res = await fetch("/api/providers");
               if (!res.ok) throw new Error("Failed to fetch providers");

               const data = await res.json();
               setProviders(data.providers || []);
          } catch (error) {
               console.error("Error fetching providers:", error);
               toast.error("Failed to load providers");
          } finally {
               setIsLoading(false);
          }
     }, []);

     useEffect(() => {
          if (setupState < 2) return;
          fetchProviders();
     }, [setupState, fetchProviders]);

     const handleFinish = useCallback(async () => {
          try {
               setIsFinishing(true);
               const res = await fetch("/api/config/setup-complete", {
                    method: "POST",
               });

               if (!res.ok) throw new Error("Failed to complete setup");
               await delay(600);
               window.location.reload();
          } catch (error) {
               console.error("Error completing setup:", error);
               toast.error("Failed to complete setup");
               setIsFinishing(false);
          }
     }, []);

     const visibleProviders = useMemo(
          () => providers.filter((provider) => provider.name?.toLowerCase() !== "transformers"),
          [providers]
     );

     const hasConfiguredProviders = useMemo(
          () =>
               visibleProviders.some(
                    (provider) => (provider.chatModels?.length ?? 0) > 0 || (provider.embeddingModels?.length ?? 0) > 0
               ),
          [visibleProviders]
     );

     const activeProviders = useMemo(
          () =>
               visibleProviders.filter(
                    (provider) => (provider.chatModels?.length ?? 0) + (provider.embeddingModels?.length ?? 0) > 0
               ),
          [visibleProviders]
     );

     const providerTypeNames = (configSections.modelProviders ?? []).map((section) => section.name);

     const getProviderByType = useCallback(
          (type: string) => visibleProviders.find((provider) => (provider.type ?? "").toLowerCase() === type),
          [visibleProviders]
     );

     const ollamaProvider = getProviderByType("ollama");
     const openAIProvider = getProviderByType("openai");
     const anthropicProvider = getProviderByType("anthropic");

     const resolveEndpoint = (provider?: ConfigModelProvider): string | undefined => {
          if (!provider) return undefined;
          const candidate =
               provider.config?.baseUrl ??
               provider.config?.baseURL ??
               provider.config?.url ??
               provider.config?.apiUrl ??
               provider.config?.apiURL ??
               provider.config?.ollamaURL ??
               provider.config?.endpoint;
          return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
     };

     const activationPanels = [
          {
               key: "ollama",
               title: "Ollama",
               description: "Download and activate local Ollama models for offline use.",
               provider: ollamaProvider,
               content: <OllamaModels ollamaBaseUrl={resolveEndpoint(ollamaProvider)} />,
               statusWhenMissing: "Not Connected",
               statusWhenReady: "Connected",
          },
          {
               key: "openai",
               title: "OpenAI",
               description: "Connect to hosted GPT models using your OpenAI credentials.",
               provider: openAIProvider,
               content: (
                    <PlaceholderBlock
                         providerName="OpenAI"
                         provider={openAIProvider}
                         message="Model activation UI coming soon."
                    />
               ),
               statusWhenMissing: "Not Connected",
               statusWhenReady: "Connected",
          },
          {
               key: "anthropic",
               title: "Anthropic",
               description: "Enable Claude models to augment your workflows.",
               provider: anthropicProvider,
               content: (
                    <PlaceholderBlock
                         providerName="Anthropic"
                         provider={anthropicProvider}
                         message="Model activation UI coming soon."
                    />
               ),
               statusWhenMissing: "Not Connected",
               statusWhenReady: "Connected",
          },
     ];

     return (
          <div className="w-[95vw] md:w-[80vw] lg:w-[65vw] mx-auto px-2 sm:px-4 md:px-6 flex flex-col space-y-6">
               <AddProvider
                    isOpen={isAddProviderOpen}
                    setIsOpen={setIsAddProviderOpen}
                    providerSections={configSections.modelProviders ?? []}
                    onProviderAdded={fetchProviders}
               />

               {setupState === 2 && (
                    <motion.div
                         initial={{ opacity: 0, y: 20 }}
                         animate={{
                              opacity: 1,
                              y: 0,
                              transition: { duration: 0.5, delay: 0.1 },
                         }}
                         className="w-full h-[calc(95vh-80px)] bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-xl shadow-sm flex flex-col overflow-hidden"
                    >
                         <div className="flex-1 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 md:py-6">
                              <div className="flex flex-row justify-between items-center mb-4 md:mb-6 pb-3 md:pb-4 border-b border-light-200 dark:border-dark-200">
                                   <div>
                                        <p className="text-xs sm:text-sm font-medium text-black dark:text-white">
                                             Manage Connections
                                        </p>
                                        <p className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 mt-0.5">
                                             Add connections to access AI models (
                                             {providerTypeNames.join(", ") || "Custom"})
                                        </p>
                                   </div>
                                   <button
                                        type="button"
                                        onClick={() => setIsAddProviderOpen(true)}
                                        disabled={isLoading}
                                        className="flex flex-row items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2 rounded-lg bg-[#F8B692] text-black hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 text-xs sm:text-sm font-medium disabled:bg-light-200 dark:disabled:bg-dark-200 disabled:text-black/40 dark:disabled:text-white/40 disabled:cursor-not-allowed disabled:active:scale-100"
                                   >
                                        Add Connection
                                   </button>
                              </div>

                              <div className="space-y-3 md:space-y-4">
                                   {isLoading ? (
                                        <NeutralState message="Loading providers..." />
                                   ) : visibleProviders.length === 0 ? (
                                        <NeutralState
                                             message="No connections configured"
                                             detail="Use the button above to add a connection."
                                        />
                                   ) : (
                                        visibleProviders.map((provider) => (
                                             <ProviderCard
                                                  key={`provider-${provider.id}`}
                                                  provider={provider}
                                                  endpoint={resolveEndpoint(provider)}
                                                  onDelete={fetchProviders}
                                             />
                                        ))
                                   )}
                              </div>
                         </div>
                    </motion.div>
               )}

               {setupState === 3 && (
                    <motion.div
                         initial={{ opacity: 0, y: 20 }}
                         animate={{
                              opacity: 1,
                              y: 0,
                              transition: { duration: 0.5, delay: 0.1 },
                         }}
                         className="w-full h-[calc(95vh-80px)] bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-xl shadow-sm flex flex-col overflow-hidden"
                    >
                         <div className="flex-1 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 md:py-6">
                              <div className="flex flex-row justify-between items-center mb-4 md:mb-6 pb-3 md:pb-4 border-b border-light-200 dark:border-dark-200">
                                   <div>
                                        <p className="text-xs sm:text-sm font-medium text-black dark:text-white">
                                             Activate Models
                                        </p>
                                        <p className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 mt-0.5">
                                             Download or enable the models you plan to use.
                                        </p>
                                   </div>
                              </div>

                              {isLoading ? (
                                   <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                                        <Loader2 className="w-5 h-5 animate-spin text-black/60 dark:text-white/60" />
                                        <p className="text-xs sm:text-sm text-black/60 dark:text-white/60">
                                             Checking providers...
                                        </p>
                                   </div>
                              ) : (
                                   <div className="space-y-4 md:space-y-5">
                                        {activeProviders.length === 0 && (
                                             <div className="flex flex-col items-center justify-center py-8 text-center space-y-3 border border-dashed border-light-200 dark:border-dark-200 rounded-xl">
                                                  <PlugZap className="w-8 h-8 text-black/50 dark:text-white/50" />
                                                  <p className="text-sm font-medium text-black dark:text-white">
                                                       No active providers yet
                                                  </p>
                                                  <p className="text-[11px] text-black/60 dark:text-white/60">
                                                       Use the Back button to configure providers on the previous page.
                                                  </p>
                                             </div>
                                        )}
                                        {activationPanels.map((panel) => (
                                             <ProviderActivationPanel
                                                  key={panel.key}
                                                  title={panel.title}
                                                  description={panel.description}
                                                  status={
                                                       panel.provider ? panel.statusWhenReady : panel.statusWhenMissing
                                                  }
                                             >
                                                  {panel.provider ? (
                                                       panel.content
                                                  ) : (
                                                       <PlaceholderBlock
                                                            providerName={panel.title}
                                                            provider={panel.provider}
                                                            message="Connect this provider on the previous step to activate its models."
                                                       />
                                                  )}
                                             </ProviderActivationPanel>
                                        ))}
                                   </div>
                              )}
                         </div>
                    </motion.div>
               )}

               <div className="flex flex-row items-center justify-between pt-2">
                    {setupState > 1 ? (
                         <motion.button
                              initial={{ opacity: 0, x: -10 }}
                              animate={{
                                   opacity: 1,
                                   x: 0,
                                   transition: { duration: 0.5 },
                              }}
                              type="button"
                              disabled={setupState <= 2 || isFinishing}
                              onClick={() => setSetupState(Math.max(1, setupState - 1))}
                              className="flex flex-row items-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 md:py-2.5 rounded-lg border border-light-200 dark:border-dark-200 bg-[#F8B692] text-black active:scale-95 hover:bg-[#e6ad82] transition-all duration-200 text-xs sm:text-sm font-medium disabled:text-black/40 dark:disabled:text-white/40 disabled:border-light-200/50 dark:disabled:border-dark-200/40 disabled:cursor-not-allowed disabled:active:scale-100"
                         >
                              <ArrowLeft className="w-4 h-4" />
                              Back
                         </motion.button>
                    ) : (
                         <span />
                    )}

                    {setupState === 2 && (
                         <motion.button
                              initial={{ opacity: 0, x: 10 }}
                              animate={{
                                   opacity: 1,
                                   x: 0,
                                   transition: { duration: 0.5 },
                              }}
                              type="button"
                              onClick={() => setSetupState(3)}
                              disabled={!hasConfiguredProviders || isLoading}
                              className="flex flex-row items-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 md:py-2.5 rounded-lg bg-[#F8B692] text-black hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 font-medium text-xs sm:text-sm disabled:bg-light-200 dark:disabled:bg-dark-200 disabled:text-black/40 dark:disabled:text-white/40 disabled:cursor-not-allowed disabled:active:scale-100"
                         >
                              <span>Next</span>
                              <ArrowRight className="w-4 h-4 md:w-[18px] md:h-[18px]" />
                         </motion.button>
                    )}

                    {setupState === 3 && (
                         <motion.button
                              initial={{ opacity: 0, x: 10 }}
                              animate={{
                                   opacity: 1,
                                   x: 0,
                                   transition: { duration: 0.5 },
                              }}
                              type="button"
                              onClick={handleFinish}
                              disabled={!hasConfiguredProviders || isLoading || isFinishing}
                              className="flex flex-row items-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 md:py-2.5 rounded-lg bg-[#F8B692] text-black hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 font-medium text-xs sm:text-sm disabled:bg-light-200 dark:disabled:bg-dark-200 disabled:text-black/40 dark:disabled:text-white/40 disabled:cursor-not-allowed disabled:active:scale-100"
                         >
                              <span>{isFinishing ? "Finishing..." : "Finish"}</span>
                              <Check className="w-4 h-4 md:w-[18px] md:h-[18px]" />
                         </motion.button>
                    )}
               </div>
          </div>
     );
};

const ProviderCard = ({
     provider,
     endpoint,
     onDelete,
}: {
     provider: ConfigModelProvider;
     endpoint?: string;
     onDelete: () => void;
}) => {
     const chatModelCount = provider.chatModels?.length ?? 0;
     const embeddingModelCount = provider.embeddingModels?.length ?? 0;
     const [isDeleting, setIsDeleting] = useState(false);

     const handleDelete = async () => {
          if (!confirm(`Are you sure you want to delete "${provider.name}"?`)) {
               return;
          }

          setIsDeleting(true);
          try {
               const res = await fetch(`/api/providers/${provider.id}`, {
                    method: "DELETE",
               });

               if (!res.ok) {
                    const error = await res.json();
                    throw new Error(error.message || "Failed to delete provider");
               }

               toast.success("Provider deleted successfully");
               onDelete();
          } catch (error) {
               console.error("Error deleting provider:", error);
               toast.error(error instanceof Error ? error.message : "Failed to delete provider");
          } finally {
               setIsDeleting(false);
          }
     };

     return (
          <div className="bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-xl p-4 flex gap-3">
               <button
                    type="button"
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="flex-shrink-0 text-black/50 dark:text-white/50 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Delete provider"
               >
                    {isDeleting ? (
                         <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                         <Trash2 className="w-4 h-4" />
                    )}
               </button>
               <div className="flex-1">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                         <div>
                              <p className="text-sm font-medium text-black dark:text-white">{provider.name}</p>
                              <p className="text-[11px] text-black/60 dark:text-white/60 uppercase tracking-wide">
                                   {(provider.type || "Custom").toUpperCase()}
                              </p>
                         </div>
                         <div className="text-[11px] text-black/60 dark:text-white/60 flex flex-col sm:items-end">
                              <span>
                                   {chatModelCount} chat {chatModelCount === 1 ? "model" : "models"}
                              </span>
                              <span>
                                   {embeddingModelCount} embedding {embeddingModelCount === 1 ? "model" : "models"}
                              </span>
                         </div>
                    </div>
                    {endpoint && (
                         <p className="text-[11px] text-black/50 dark:text-white/50 mt-2 break-all">
                              Endpoint: {endpoint}
                         </p>
                    )}
               </div>
          </div>
     );
};

const NeutralState = ({ message, detail }: { message: string; detail?: string }) => (
     <div className="flex flex-col items-center justify-center py-8 md:py-12 text-center">
          <p className="text-xs sm:text-sm font-medium text-black/70 dark:text-white/70">{message}</p>
          {detail && <p className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 mt-1">{detail}</p>}
     </div>
);

type ProviderActivationPanelProps = {
     title: string;
     description: string;
     status: string;
     children?: ReactNode;
};

const statusToneClasses: Record<string, string> = {
     Connected: "bg-emerald-100 text-emerald-700",
     "Not Connected": "bg-amber-100 text-amber-700",
};

const ProviderActivationPanel = ({ title, description, status, children }: ProviderActivationPanelProps) => {
     return (
          <div className="bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-xl p-4 md:p-5">
               <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div>
                         <p className="text-sm font-medium text-black dark:text-white">{title}</p>
                         <p className="text-xs text-black/60 dark:text-white/60">{description}</p>
                    </div>
                    <span
                         className={`text-xs font-medium px-2.5 py-1 rounded-lg ${
                              statusToneClasses[status] ||
                              "bg-light-200 dark:bg-dark-200 text-black/60 dark:text-white/60"
                         }`}
                    >
                         {status}
                    </span>
               </div>
               {children && <div className="mt-4">{children}</div>}
          </div>
     );
};

const PlaceholderBlock = ({
     providerName,
     provider,
     message,
}: {
     providerName: string;
     provider?: ConfigModelProvider;
     message: string;
}) => {
     return (
          <div className="bg-light-primary dark:bg-dark-primary border border-dashed border-light-200 dark:border-dark-200 rounded-lg p-4 text-[11px] text-black/70 dark:text-white/70">
               <p>{provider ? message : `${providerName} is not configured yet. ${message}`}</p>
          </div>
     );
};

export default SetupConfig;
