import { Switch } from "@headlessui/react";
import { ConfigModelProvider } from "../models/types";

// Appearance of various UI config fields- can have input box that accepts string, a selection menu,
// box w/ special properties for passwords, switch, text area fields that are equivalent to string config
// fields, but for long-form entry
export type UIConfigField =
     | StringUIConfigField
     | SelectUIConfigField
     | TextareaUIConfigField
     | SwitchUIConfigField
     | NumberUIConfigField;

type BaseUIConfigField = {
     name: string;
     key: string;
     required: boolean;
     description: string;
     scope: "client" | "server";
     env?: string;
};

export type StringUIConfigField = BaseUIConfigField & {
     type: "string";
     placeholder?: string;
     default?: string;
};

type SelectUIConfigFieldOptions = {
     name: string;
     value: string;
};

export type SelectUIConfigField = BaseUIConfigField & {
     type: "select";
     default?: string;
     options: SelectUIConfigFieldOptions[];
};

export type TextareaUIConfigField = BaseUIConfigField & {
     type: "textarea";
     placeholder?: string;
     default?: string;
};

export type SwitchUIConfigField = BaseUIConfigField & {
     type: "switch";
     default?: boolean;
};

export type NumberUIConfigField = BaseUIConfigField & {
     type: "number";
     placeholder?: string;
     default?: number;
     min?: number;
     max?: number;
     step?: number;
};

export type ModelProviderUISection = {
     name: string;
     key: string;
     fields: UIConfigField[];
};

export type FolderUISection = {
     name: string;
     key: string;
     fields: UIConfigField[];
     /** Optional URI value associated with this folder section */
     uri?: string;
};

export type UIConfigSections = {
     preferences: UIConfigField[];
     personalization: UIConfigField[];
     modelProviders: ModelProviderUISection[];
     folders?: FolderUISection[];
     search?: UIConfigField[];
};

export type Config = {
     version: number;
     setupComplete: boolean;
     preferences: {
          [key: string]: any;
     };
     personalization: {
          [key: string]: any;
     };
     modelProviders: ConfigModelProvider[];
     folder?: {
          path?: string;
          [key: string]: any;
     };
};
