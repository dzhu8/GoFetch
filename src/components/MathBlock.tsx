"use client";

import React, { useMemo } from "react";
import katex from "katex";

/**
 * Renders a KaTeX math expression (display or inline mode).
 * The LaTeX source is passed as a base64-encoded `data-latex` attribute
 * to prevent markdown-to-jsx from mangling special characters.
 */
export function MathDisplay({ "data-latex": dataLatex, children }: { "data-latex"?: string; children?: React.ReactNode }) {
     const latex = dataLatex ? atob(dataLatex) : "";
     const html = useMemo(() => {
          try {
               return katex.renderToString(latex, { displayMode: true, throwOnError: false, strict: false });
          } catch {
               return `<span class="text-red-500">[Math error: ${latex.slice(0, 80)}]</span>`;
          }
     }, [latex]);

     return <div className="katex-display my-4 overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MathInline({ "data-latex": dataLatex, children }: { "data-latex"?: string; children?: React.ReactNode }) {
     const latex = dataLatex ? atob(dataLatex) : "";
     const html = useMemo(() => {
          try {
               return katex.renderToString(latex, { displayMode: false, throwOnError: false, strict: false });
          } catch {
               return `<span class="text-red-500">[Math error]</span>`;
          }
     }, [latex]);

     return <span className="katex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Pre-process markdown content to replace LaTeX delimiters with custom HTML tags.
 * Converts:
 *   $$...$$  ->  <mathblock data-latex="base64">.</mathblock>
 *   $...$    ->  <mathinline data-latex="base64">.</mathinline>
 *
 * Base64-encoding prevents markdown-to-jsx from parsing the LaTeX content.
 */
export function preprocessMath(content: string): string {
     // Display math: $$ ... $$ (possibly spanning multiple lines)
     let result = content.replace(/\$\$([\s\S]+?)\$\$/g, (_match, latex: string) => {
          const trimmed = latex.trim();
          const encoded = btoa(trimmed);
          return `<mathblock data-latex="${encoded}">.</mathblock>`;
     });

     // Inline math: $ ... $ (single line, non-greedy)
     // Negative lookbehind for $ to avoid matching $$ remnants
     // Negative lookbehind for \ to avoid matching \$
     result = result.replace(/(?<!\$|\\)\$([^\n$]+?)\$(?!\$)/g, (_match, latex: string) => {
          const trimmed = latex.trim();
          if (!trimmed) return _match;
          const encoded = btoa(trimmed);
          return `<mathinline data-latex="${encoded}">.</mathinline>`;
     });

     return result;
}
