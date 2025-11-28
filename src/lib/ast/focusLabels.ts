import type { SerializedNode, SupportedLanguage } from "./types";

export function inferFocusSymbolName(language: SupportedLanguage, node: SerializedNode): string | null {
     const snippet = node.textSnippet?.trim();
     if (!snippet) {
          return null;
     }

     const header = snippet.split(/\r?\n/)[0]?.trim() ?? "";
     if (!header) {
          return null;
     }

     switch (language) {
          case "javascript":
          case "typescript":
          case "tsx":
               return inferFromJsLike(header, node.type);
          case "python":
               return inferFromPython(header, node.type);
          case "rust":
               return inferFromRust(header, node.type);
          case "css":
          case "html":
          default:
               return null;
     }
}

function inferFromJsLike(header: string, nodeType: string): string | null {
     const cleaned = normalizeWhitespace(header);

     if (/class\s+/i.test(cleaned)) {
          return matchIdentifier(cleaned, /class\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (/interface\s+/i.test(cleaned)) {
          return matchIdentifier(cleaned, /interface\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (/enum\s+/i.test(cleaned)) {
          return matchIdentifier(cleaned, /enum\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (/type\s+/i.test(cleaned)) {
          return matchIdentifier(cleaned, /type\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (/function/i.test(cleaned) || nodeType.includes("Function")) {
          const functionMatch = matchIdentifier(cleaned, /function\s*\*?\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
          if (functionMatch) {
               return functionMatch;
          }
     }

     if (/const\s+/i.test(cleaned) || /let\s+/i.test(cleaned) || /var\s+/i.test(cleaned)) {
          const arrowMatch = matchIdentifier(
               cleaned,
               /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_\-$]*)\s*=\s*(?:async\s+)?(?:function|\()/i
          );
          if (arrowMatch) {
               return arrowMatch;
          }
     }

     if (nodeType === "MethodDeclaration" || nodeType === "MethodSignature") {
          const methodMatch = matchIdentifier(cleaned, /([A-Za-z_][A-Za-z0-9_\-$]*)\s*\(/i);
          if (methodMatch) {
               return methodMatch;
          }
     }

     return null;
}

function inferFromPython(header: string, nodeType: string): string | null {
     const cleaned = normalizeWhitespace(header);

     if (cleaned.includes("__name__") && cleaned.includes("__main__")) {
          return "__main__ guard";
     }

     if (nodeType === "ClassDefinition" && cleaned.startsWith("class ")) {
          return matchIdentifier(cleaned, /class\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if ((nodeType === "FunctionDefinition" || nodeType === "AsyncFunctionDefinition") && cleaned.includes("def")) {
          const fnMatch = matchIdentifier(cleaned, /def\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
          if (fnMatch) {
               return fnMatch;
          }
     }

     return null;
}

function inferFromRust(header: string, nodeType: string): string | null {
     const cleaned = normalizeWhitespace(header);

     if (nodeType === "FunctionItem" || cleaned.startsWith("fn ")) {
          return matchIdentifier(cleaned, /fn\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (nodeType === "StructItem") {
          return matchIdentifier(cleaned, /struct\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (nodeType === "EnumItem") {
          return matchIdentifier(cleaned, /enum\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (nodeType === "TraitItem") {
          return matchIdentifier(cleaned, /trait\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (nodeType === "ImplItem") {
          return matchIdentifier(cleaned, /impl(?:\s*<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     if (nodeType === "ModItem") {
          return matchIdentifier(cleaned, /mod\s+([A-Za-z_][A-Za-z0-9_\-$]*)/i);
     }

     return null;
}

function normalizeWhitespace(value: string): string {
     return value.replace(/\s+/g, " ").trim();
}

function matchIdentifier(value: string, pattern: RegExp): string | null {
     const match = pattern.exec(value);
     if (match?.[1]) {
          return match[1];
     }
     return null;
}
