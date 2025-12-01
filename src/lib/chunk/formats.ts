import path from "path";

import type { SupportedTextFormat } from "./types";

const FORMAT_BY_EXTENSION: Record<string, SupportedTextFormat> = {
     // Markdown
     ".md": "markdown",
     ".mdx": "markdown",
     ".markdown": "markdown",

     // Plain text
     ".txt": "text",
     ".text": "text",

     // Data formats
     ".json": "json",
     ".jsonc": "json",
     ".json5": "json",

     ".yaml": "yaml",
     ".yml": "yaml",

     ".toml": "toml",

     ".xml": "xml",
     ".xhtml": "xml",
     ".svg": "xml",

     ".csv": "csv",
     ".tsv": "csv",

     // Config
     ".ini": "ini",
     ".cfg": "ini",
     ".conf": "ini",

     ".env": "env",
     ".env.local": "env",
     ".env.development": "env",
     ".env.production": "env",

     // Logs
     ".log": "log",
};

// Files without extension but with known names
const KNOWN_TEXT_FILES: Record<string, SupportedTextFormat> = {
     readme: "markdown",
     changelog: "markdown",
     license: "text",
     makefile: "text",
     dockerfile: "text",
     ".gitignore": "text",
     ".dockerignore": "text",
     ".npmignore": "text",
     ".prettierrc": "json",
     ".eslintrc": "json",
     ".babelrc": "json",
     ".editorconfig": "ini",
};

export function detectTextFormat(filePath: string): SupportedTextFormat | null {
     const ext = path.extname(filePath).toLowerCase();

     if (ext && FORMAT_BY_EXTENSION[ext]) {
          return FORMAT_BY_EXTENSION[ext];
     }

     // Check for known files by name
     const basename = path.basename(filePath).toLowerCase();
     if (KNOWN_TEXT_FILES[basename]) {
          return KNOWN_TEXT_FILES[basename];
     }

     // Check without extension
     const nameWithoutExt = path.basename(filePath, ext).toLowerCase();
     if (KNOWN_TEXT_FILES[nameWithoutExt]) {
          return KNOWN_TEXT_FILES[nameWithoutExt];
     }

     return null;
}

export function isSupportedTextFile(filePath: string): boolean {
     return detectTextFormat(filePath) !== null;
}

export function getSupportedExtensions(): string[] {
     return Object.keys(FORMAT_BY_EXTENSION);
}

export function getKnownTextFileNames(): string[] {
     return Object.keys(KNOWN_TEXT_FILES);
}
