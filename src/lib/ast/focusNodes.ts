import type { SerializedNode, SupportedLanguage } from "./types";

const MULTI_LINE_LANGUAGES: SupportedLanguage[] = ["javascript", "typescript", "tsx", "python", "rust"];

const TYPE_ALLOWLIST: Partial<Record<SupportedLanguage, Set<string>>> = {
     javascript: new Set([
          "FunctionDeclaration",
          "ClassDeclaration",
          "Function",
          "MethodDeclaration",
          "ArrowFunction",
          "ExportDeclaration",
          "ExportDefaultDeclaration",
          "ExportStatement",
          "GeneratorFunction",
          "AsyncFunction",
     ]),
     typescript: new Set([
          "FunctionDeclaration",
          "ClassDeclaration",
          "InterfaceDeclaration",
          "EnumDeclaration",
          "TypeAliasDeclaration",
          "MethodSignature",
          "Function",
          "ArrowFunction",
          "GeneratorFunction",
          "AsyncFunction",
     ]),
     tsx: new Set([
          "FunctionDeclaration",
          "ClassDeclaration",
          "InterfaceDeclaration",
          "EnumDeclaration",
          "TypeAliasDeclaration",
          "MethodSignature",
          "ArrowFunction",
          "Function",
     ]),
     python: new Set(["FunctionDefinition", "ClassDefinition", "AsyncFunctionDefinition"]),
     rust: new Set(["FunctionItem", "StructItem", "EnumItem", "TraitItem", "ImplItem", "ModItem"]),
};

interface FocusOptions {
     requireMultiLine?: boolean;
}

export function filterFocusNodes(
     ast: SerializedNode,
     language: SupportedLanguage,
     options: FocusOptions = { requireMultiLine: true }
): SerializedNode {
     const children = collectFocusChildren(ast.children, language, options);
     return {
          ...ast,
          children,
          childCount: children.length,
     };
}

function collectFocusChildren(
     children: SerializedNode[],
     language: SupportedLanguage,
     options: FocusOptions
): SerializedNode[] {
     const results: SerializedNode[] = [];

     for (const child of children) {
          const promoted = promoteFocusNode(child, language, options);
          results.push(...promoted);
     }

     return results;
}

function promoteFocusNode(node: SerializedNode, language: SupportedLanguage, options: FocusOptions): SerializedNode[] {
     const filteredChildren = collectFocusChildren(node.children, language, options);
     const includeNode = isFocusNode(language, node, options);

     if (includeNode) {
          return [
               {
                    ...node,
                    children: filteredChildren,
                    childCount: filteredChildren.length,
               },
          ];
     }

     return filteredChildren;
}

function isFocusNode(language: SupportedLanguage, node: SerializedNode, options: FocusOptions): boolean {
     if (options.requireMultiLine && !spansMultipleLines(node)) {
          return false;
     }

     if (!MULTI_LINE_LANGUAGES.includes(language)) {
          return spansMultipleLines(node);
     }

     if (language === "python" && isPythonMainGuard(node)) {
          return true;
     }

     const allowlist = TYPE_ALLOWLIST[language];
     if (allowlist?.has(node.type)) {
          return true;
     }

     if (language === "typescript" || language === "tsx") {
          if (node.type === "DeclareFunction" || node.type === "DeclareInterface") {
               return true;
          }
     }

     return false;
}

function isPythonMainGuard(node: SerializedNode): boolean {
     if (node.type !== "IfStatement" && node.type !== "IfClause") {
          return false;
     }

     if (!node.textSnippet) {
          return false;
     }

     const snippet = node.textSnippet;
     return snippet.includes("__name__") && snippet.includes("__main__");
}

function spansMultipleLines(node: SerializedNode): boolean {
     return node.startPosition.row < node.endPosition.row;
}
