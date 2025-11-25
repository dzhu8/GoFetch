import path from "path";
import type { LRParser } from "@lezer/lr";
import { parser as javascriptParser } from "@lezer/javascript";
import { parser as pythonParser } from "@lezer/python";
import { parser as rustParser } from "@lezer/rust";
import { parser as cssParser } from "@lezer/css";
import { parser as htmlParser } from "@lezer/html";

import type { SupportedLanguage } from "./types";

const JAVASCRIPT_WITH_JSX = javascriptParser.configure({ dialect: "jsx" });
const TYPESCRIPT_ONLY = javascriptParser.configure({ dialect: "ts" });
const TSX_WITH_TS_JSX = javascriptParser.configure({ dialect: "ts jsx" });

const LANGUAGE_BY_EXTENSION: Record<string, SupportedLanguage> = {
     ".js": "javascript",
     ".cjs": "javascript",
     ".mjs": "javascript",
     ".jsx": "javascript",
     ".ts": "typescript",
     ".tsx": "tsx",
     ".py": "python",
     ".rs": "rust",
     ".css": "css",
     ".scss": "css",
     ".sass": "css",
     ".less": "css",
     ".html": "html",
     ".htm": "html",
};

const LANGUAGE_TO_PARSER: Record<SupportedLanguage, LRParser> = {
     javascript: JAVASCRIPT_WITH_JSX,
     typescript: TYPESCRIPT_ONLY,
     tsx: TSX_WITH_TS_JSX,
     python: pythonParser,
     rust: rustParser,
     css: cssParser,
     html: htmlParser,
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
     const ext = path.extname(filePath).toLowerCase();
     return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

export function getParser(language: SupportedLanguage): LRParser {
     return LANGUAGE_TO_PARSER[language];
}

export function isSupportedFile(filePath: string): boolean {
     return detectLanguage(filePath) !== null;
}
