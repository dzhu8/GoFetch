import { BaseOutputParser } from "@langchain/core/output_parsers";

interface FileInfo {
     filename: string;
     language: string;
}

interface FileLinksOutputParserArgs {
     key?: string;
}

const extensionToLanguage: Record<string, string> = {
     // JavaScript / TypeScript
     js: "javascript",
     jsx: "javascript",
     ts: "typescript",
     tsx: "typescript",
     mjs: "javascript",
     cjs: "javascript",

     // Web
     html: "html",
     htm: "html",
     css: "css",
     scss: "scss",
     sass: "sass",
     less: "less",

     // Python
     py: "python",
     pyw: "python",
     pyi: "python",

     // Java / JVM
     java: "java",
     kt: "kotlin",
     kts: "kotlin",
     scala: "scala",
     groovy: "groovy",

     // C / C++
     c: "c",
     h: "c",
     cpp: "cpp",
     cc: "cpp",
     cxx: "cpp",
     hpp: "cpp",
     hxx: "cpp",

     // C#
     cs: "csharp",

     // Go
     go: "go",

     // Rust
     rs: "rust",

     // Ruby
     rb: "ruby",
     erb: "ruby",

     // PHP
     php: "php",

     // Swift
     swift: "swift",

     // Shell
     sh: "shell",
     bash: "shell",
     zsh: "shell",
     fish: "shell",
     ps1: "powershell",
     psm1: "powershell",

     // Data / Config
     json: "json",
     yaml: "yaml",
     yml: "yaml",
     toml: "toml",
     xml: "xml",
     ini: "ini",
     env: "env",

     // Markdown / Docs
     md: "markdown",
     mdx: "markdown",
     rst: "restructuredtext",
     txt: "plaintext",

     // SQL
     sql: "sql",

     // Other
     r: "r",
     lua: "lua",
     pl: "perl",
     pm: "perl",
     ex: "elixir",
     exs: "elixir",
     erl: "erlang",
     hrl: "erlang",
     hs: "haskell",
     ml: "ocaml",
     mli: "ocaml",
     fs: "fsharp",
     fsi: "fsharp",
     clj: "clojure",
     cljs: "clojure",
     dart: "dart",
     vue: "vue",
     svelte: "svelte",
};

function getLanguageFromExtension(filename: string): string {
     const ext = filename.split(".").pop()?.toLowerCase() ?? "";
     return extensionToLanguage[ext] ?? "unknown";
}

function getFilenameFromPath(filePath: string): string {
     // Handle both forward slashes and backslashes
     const parts = filePath.split(/[/\\]/);
     return parts[parts.length - 1] || filePath;
}

class FileLinksOutputParser extends BaseOutputParser<FileInfo[]> {
     private key = "links";

     constructor(args?: FileLinksOutputParserArgs) {
          super();
          this.key = args?.key ?? this.key;
     }

     static lc_name() {
          return "FileLinksOutputParser";
     }

     lc_namespace = ["langchain", "output_parsers", "file_links_output_parser"];

     async parse(text: string): Promise<FileInfo[]> {
          text = text.trim() || "";

          const regex = /^(\s*(-|\*|\d+\.\s|\d+\)\s|\u2022)\s*)+/;
          const startKeyIndex = text.indexOf(`<${this.key}>`);
          const endKeyIndex = text.indexOf(`</${this.key}>`);

          if (startKeyIndex === -1 || endKeyIndex === -1) {
               return [];
          }

          const linksStartIndex = startKeyIndex + `<${this.key}>`.length;
          const linksEndIndex = endKeyIndex;
          const lines = text
               .slice(linksStartIndex, linksEndIndex)
               .trim()
               .split("\n")
               .filter((line) => line.trim() !== "")
               .map((line) => line.replace(regex, "").trim());

          return lines.map((filePath) => {
               const filename = getFilenameFromPath(filePath);
               const language = getLanguageFromExtension(filename);
               return { filename, language };
          });
     }

     getFormatInstructions(): string {
          throw new Error("Not implemented.");
     }
}

export default FileLinksOutputParser;
