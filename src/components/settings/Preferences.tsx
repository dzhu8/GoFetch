import { UIConfigField } from "@/lib/config/types";
import SettingsField from "./SettingsField";
import { ConfigModelProvider } from "@/lib/models/types";
import SettingsDropdown from "./SettingsDropdown";
import { ModelPreference } from "@/lib/models/modelPreference";

type PreferencesProps = {
     fields: UIConfigField[];
     values: Record<string, any>;
     modelProviders?: ConfigModelProvider[];
     defaultChatModel?: ModelPreference | null;
     defaultEmbeddingModel?: ModelPreference | null;
};

const Preferences = ({
     fields,
     values,
     modelProviders = [],
     defaultChatModel,
     defaultEmbeddingModel,
}: PreferencesProps) => {
     return (
          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
               {fields.map((field) => (
                    <SettingsField
                         key={field.key}
                         field={field}
                         value={values[field.key] ?? field.default}
                         dataAdd="preferences"
                    />
               ))}
               <div className="space-y-6">
                    <SettingsDropdown
                         label="Default Chat Model"
                         description="Select which model GoFetch should use for conversations by default."
                         type="chat"
                         providers={modelProviders}
                         value={defaultChatModel}
                    />
                    <SettingsDropdown
                         label="Default Embedding Model"
                         description="Choose the model used to embed and index your code."
                         type="embedding"
                         providers={modelProviders}
                         value={defaultEmbeddingModel}
                    />
               </div>
          </div>
     );
};

export default Preferences;
