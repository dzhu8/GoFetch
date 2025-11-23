import { Description, Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { Loader2, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ModelProviderUISection, UIConfigField } from "@/lib/config/types";
import { ConfigModelProvider } from "@/lib/models/types";
import Select from "../Select";
import { toast } from "sonner";

type AddProviderProps = {
     isOpen: boolean;
     setIsOpen: (open: boolean) => void;
     providerSections: ModelProviderUISection[];
     onProviderAdded: () => void;
};

const AddProvider = ({ isOpen, setIsOpen, providerSections, onProviderAdded }: AddProviderProps) => {
     const [selectedProviderType, setSelectedProviderType] = useState<string>("");
     const [providerName, setProviderName] = useState<string>("");
     const [configValues, setConfigValues] = useState<Record<string, any>>({});
     const [isSubmitting, setIsSubmitting] = useState(false);

     const selectedSection = useMemo(
          () => providerSections.find((section) => section.key === selectedProviderType),
          [selectedProviderType, providerSections]
     );

     const handleClose = () => {
          if (isSubmitting) return;
          setIsOpen(false);
          // Reset form
          setTimeout(() => {
               setSelectedProviderType("");
               setProviderName("");
               setConfigValues({});
          }, 300);
     };

     const handleSubmit = async () => {
          if (!selectedProviderType || !providerName.trim()) {
               toast.error("Please select a provider type and enter a name");
               return;
          }

          // Apply defaults for empty required fields that have default values
          const requiredFields = selectedSection?.fields.filter((field) => field.required) || [];
          const updatedConfigValues = { ...configValues };

          requiredFields.forEach((field) => {
               const currentValue = updatedConfigValues[field.key];
               const isEmpty = !currentValue || currentValue.toString().trim() === "";

               if (isEmpty && field.default) {
                    // Apply default value if field is empty and has a default
                    updatedConfigValues[field.key] = field.default;
               }
          });

          // Now check for truly missing fields (no value and no default)
          const missingFields = requiredFields.filter((field) => {
               const value = updatedConfigValues[field.key];
               return !value || value.toString().trim() === "";
          });

          if (missingFields.length > 0) {
               toast.error(`Please fill in all required fields: ${missingFields.map((f) => f.name).join(", ")}`);
               return;
          }

          setIsSubmitting(true);

          try {
               const res = await fetch("/api/providers", {
                    method: "POST",
                    headers: {
                         "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                         name: providerName,
                         type: selectedProviderType,
                         config: updatedConfigValues,
                         chatModels: [],
                         embeddingModels: [],
                    }),
               });

               if (!res.ok) {
                    const error = await res.json();
                    throw new Error(error.message || "Failed to add provider");
               }

               toast.success("Provider added successfully");
               onProviderAdded();
               handleClose();
          } catch (error) {
               console.error("Error adding provider:", error);
               toast.error(error instanceof Error ? error.message : "Failed to add provider");
          } finally {
               setIsSubmitting(false);
          }
     };

     const handleFieldChange = (fieldKey: string, value: any) => {
          setConfigValues((prev) => ({
               ...prev,
               [fieldKey]: value,
          }));
     };

     return (
          <AnimatePresence>
               {isOpen && (
                    <Dialog open={isOpen} onClose={handleClose} className="relative z-50">
                         <motion.div
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              className="fixed inset-0 bg-black/30 backdrop-blur-sm"
                              aria-hidden="true"
                         />

                         <div className="fixed inset-0 flex items-center justify-center p-4">
                              <DialogPanel
                                   as={motion.div}
                                   initial={{ opacity: 0, scale: 0.95 }}
                                   animate={{ opacity: 1, scale: 1 }}
                                   exit={{ opacity: 0, scale: 0.95 }}
                                   className="mx-auto max-w-2xl w-full rounded-xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 shadow-2xl overflow-hidden"
                              >
                                   <div className="flex items-center justify-between border-b border-light-200 dark:border-dark-200 px-6 py-4">
                                        <DialogTitle className="text-lg font-medium text-black dark:text-white">
                                             Add Connection
                                        </DialogTitle>
                                        <button
                                             type="button"
                                             onClick={handleClose}
                                             disabled={isSubmitting}
                                             className="text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white transition-colors disabled:opacity-50"
                                        >
                                             <X className="w-5 h-5" />
                                        </button>
                                   </div>

                                   <div className="px-6 py-5 max-h-[calc(100vh-200px)] overflow-y-auto">
                                        <Description className="text-sm text-black/60 dark:text-white/60 mb-6">
                                             Add a new model provider connection to access AI models. Configure the
                                             provider type and connection settings below.
                                        </Description>

                                        <div className="space-y-5">
                                             {/* Provider Type Selection */}
                                             <div>
                                                  <label className="block text-sm font-medium text-black dark:text-white mb-2">
                                                       Provider Type <span className="text-red-500">*</span>
                                                  </label>
                                                  <Select
                                                       value={selectedProviderType}
                                                       onChange={(e) => {
                                                            setSelectedProviderType(e.target.value);
                                                            setConfigValues({});
                                                       }}
                                                       options={[
                                                            { value: "", label: "Select a provider type..." },
                                                            ...providerSections.map((section) => ({
                                                                 value: section.key,
                                                                 label: section.name,
                                                            })),
                                                       ]}
                                                       disabled={isSubmitting}
                                                       className="!text-sm"
                                                  />
                                             </div>

                                             {/* Provider Name */}
                                             <div>
                                                  <label className="block text-sm font-medium text-black dark:text-white mb-2">
                                                       Connection Name <span className="text-red-500">*</span>
                                                  </label>
                                                  <input
                                                       type="text"
                                                       value={providerName}
                                                       onChange={(e) => setProviderName(e.target.value)}
                                                       placeholder="e.g., My OpenAI Account"
                                                       disabled={isSubmitting}
                                                       className="w-full rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary px-4 py-2.5 text-sm text-black dark:text-white placeholder:text-black/40 dark:placeholder:text-white/40 focus-visible:outline-none focus-visible:border-light-300 dark:focus-visible:border-dark-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                                                  />
                                             </div>

                                             {/* Dynamic Fields Based on Provider Type */}
                                             {selectedSection && (
                                                  <div className="space-y-4 pt-2">
                                                       <h3 className="text-sm font-medium text-black dark:text-white border-t border-light-200 dark:border-dark-200 pt-4">
                                                            Configuration
                                                       </h3>
                                                       {selectedSection.fields.map((field) => (
                                                            <ProviderField
                                                                 key={field.key}
                                                                 field={field}
                                                                 value={configValues[field.key]}
                                                                 onChange={(value) =>
                                                                      handleFieldChange(field.key, value)
                                                                 }
                                                                 disabled={isSubmitting}
                                                            />
                                                       ))}
                                                  </div>
                                             )}
                                        </div>
                                   </div>

                                   <div className="flex items-center justify-end gap-3 border-t border-light-200 dark:border-dark-200 px-6 py-4">
                                        <button
                                             type="button"
                                             onClick={handleClose}
                                             disabled={isSubmitting}
                                             className="px-4 py-2 rounded-lg text-sm font-medium text-black dark:text-white hover:bg-light-secondary dark:hover:bg-dark-secondary transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                                        >
                                             Cancel
                                        </button>
                                        <button
                                             type="button"
                                             onClick={handleSubmit}
                                             disabled={isSubmitting || !selectedProviderType || !providerName.trim()}
                                             className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100"
                                        >
                                             {isSubmitting ? (
                                                  <>
                                                       <Loader2 className="w-4 h-4 animate-spin" />
                                                       Adding...
                                                  </>
                                             ) : (
                                                  <>
                                                       <Plus className="w-4 h-4" />
                                                       Add Connection
                                                  </>
                                             )}
                                        </button>
                                   </div>
                              </DialogPanel>
                         </div>
                    </Dialog>
               )}
          </AnimatePresence>
     );
};

// Helper component to render different field types
const ProviderField = ({
     field,
     value,
     onChange,
     disabled,
}: {
     field: UIConfigField;
     value: any;
     onChange: (value: any) => void;
     disabled: boolean;
}) => {
     if (field.type === "string") {
          return (
               <div>
                    <label className="block text-sm font-medium text-black dark:text-white mb-2">
                         {field.name}
                         {field.required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    {field.description && (
                         <p className="text-xs text-black/50 dark:text-white/50 mb-2">{field.description}</p>
                    )}
                    <input
                         type="text"
                         value={value || ""}
                         onChange={(e) => onChange(e.target.value)}
                         placeholder={field.placeholder || (field.default ? `Default: ${field.default}` : "")}
                         disabled={disabled}
                         className="w-full rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary px-4 py-2.5 text-sm text-black dark:text-white placeholder:text-black/40 dark:placeholder:text-white/40 focus-visible:outline-none focus-visible:border-light-300 dark:focus-visible:border-dark-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    />
               </div>
          );
     }

     if (field.type === "textarea") {
          return (
               <div>
                    <label className="block text-sm font-medium text-black dark:text-white mb-2">
                         {field.name}
                         {field.required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    {field.description && (
                         <p className="text-xs text-black/50 dark:text-white/50 mb-2">{field.description}</p>
                    )}
                    <textarea
                         value={value || ""}
                         onChange={(e) => onChange(e.target.value)}
                         placeholder={field.placeholder}
                         disabled={disabled}
                         rows={4}
                         className="w-full rounded-lg border border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary px-4 py-2.5 text-sm text-black dark:text-white placeholder:text-black/40 dark:placeholder:text-white/40 focus-visible:outline-none focus-visible:border-light-300 dark:focus-visible:border-dark-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed resize-none"
                    />
               </div>
          );
     }

     if (field.type === "select") {
          return (
               <div>
                    <label className="block text-sm font-medium text-black dark:text-white mb-2">
                         {field.name}
                         {field.required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    {field.description && (
                         <p className="text-xs text-black/50 dark:text-white/50 mb-2">{field.description}</p>
                    )}
                    <Select
                         value={value || ""}
                         onChange={(e) => onChange(e.target.value)}
                         options={[
                              { value: "", label: "Select an option..." },
                              ...field.options.map((opt) => ({
                                   value: opt.value,
                                   label: opt.name,
                              })),
                         ]}
                         disabled={disabled}
                         className="!text-sm"
                    />
               </div>
          );
     }

     // Add more field types as needed
     return null;
};

export default AddProvider;
