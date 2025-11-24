import path from "path";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import Rust from "tree-sitter-rust";
import TypeScriptLanguages from "tree-sitter-typescript";
import * as CSS from "tree-sitter-css";
import HTML from "tree-sitter-html";

import type { SupportedLanguage } from "./types";

type LanguageModule = {
     typescript: Parser.Language;
     tsx: Parser.Language;
};

const { typescript, tsx } = TypeScriptLanguages as unknown as LanguageModule;

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

const LANGUAGE_TO_MODULE: Record<SupportedLanguage, Parser.Language> = {
     javascript: JavaScript as unknown as Parser.Language,
     typescript,
     tsx,
     python: Python as unknown as Parser.Language,
     rust: Rust as unknown as Parser.Language,
     css: CSS as unknown as Parser.Language,
     html: HTML as unknown as Parser.Language,
};

const PARSER_CACHE = new Map<SupportedLanguage, Parser>();

export function detectLanguage(filePath: string): SupportedLanguage | null {
     const ext = path.extname(filePath).toLowerCase();
     return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

export function getParser(language: SupportedLanguage): Parser {
     const cached = PARSER_CACHE.get(language);
     if (cached) {
          return cached;
     }

     const parser = new Parser();
     parser.setLanguage(LANGUAGE_TO_MODULE[language]);
     PARSER_CACHE.set(language, parser);
     return parser;
}

export function isSupportedFile(filePath: string): boolean {
     return detectLanguage(filePath) !== null;
}