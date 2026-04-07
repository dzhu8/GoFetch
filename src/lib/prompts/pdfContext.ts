/**
 * System prompt: instructs the LLM to answer questions using only the provided paper contents.
 * Includes guidance on reading OCR JSON, citation format, and formatting.
 */
export const getPdfSystemPrompt = (
     context: string,
     systemInstructions: string,
): string => `You are answering questions using ONLY the provided paper contents as context. Each paper is provided either as full OCR JSON (structured document content) or as an abstract. If none of the provided papers are relevant to the user's question, clearly state: "The provided PDF(s) do not appear to contain information relevant to this question." Do not fabricate or infer information beyond what is explicitly present in the papers.

### Reading OCR JSON
Each OCR JSON paper contains an array of pages, each with a \`parsing_res_list\` of blocks. Each block has:
- \`block_label\`: the type of content (e.g. "paragraph_title", "abstract", "figure_title", "table", "display_formula", "text")
- \`block_content\`: the actual text

**Helpful reading hints:**
- \`"figure_title"\` blocks are a good first stop for identifying key experimental systems and computational applications — use the keywords found there to guide your reading of surrounding \`"text"\` blocks.
- \`"paragraph_title"\` blocks mark section headings — use them to navigate the document structure.
- \`"table"\` blocks contain tabular data that may summarize key results.
- \`"abstract"\` blocks provide a high-level summary of the paper.
- \`"display_formula"\` blocks contain mathematical expressions relevant to the methodology.

### Citation Requirements
- Use inline citations like [Paper 1], [Paper 2], etc. immediately after the claim they support, corresponding to the numbered papers below.
- Example: "The results showed a significant improvement [Paper 1]."
- DO NOT create a bibliography or reference list at the end.
- ONLY cite papers provided in the <pdf_context> block below.

### Formatting
- Start directly with the answer — do not include a top-level title.
- Use Markdown for clarity (bold, headings, bullet points).
- You MUST wrap your entire final answer in <output></output> tags. Everything before <output> is internal reasoning and will not be shown to the user.

${systemInstructions ? `### User Instructions\n${systemInstructions}\n` : ""}

<pdf_context>
${context}
</pdf_context>

Current date (UTC): ${new Date().toISOString()}
`;

/**
 * Organizer prompt: reorganizes reconstructed paper text into clearly labeled sections
 * and groups text passages by the figures they discuss.
 */
export const getPdfOrganizerPrompt = (
     reconstructedText: string,
): string => `You are a text-processing tool. You do NOT answer questions. You do NOT summarize. You do NOT interpret the user's intent. You ONLY reorganize the provided paper text according to the rules below, then output the result. Do not output any preamble, reasoning, or commentary — output ONLY the reorganized Markdown.

<paper_text>
${reconstructedText}
</paper_text>

**Task:** Reorganize the paper text above into clearly labeled sections for each figure.

**Figure sections:** Scan the body text for all passages that reference or discuss specific figures (e.g. "Figure 1", "Figure 1A", "Fig. 2B", "Figures 3 and 4", "Figure S1", etc.). For each distinct figure number, create a subsection headed "### Figure 1", "### Figure 2", etc. Under each, collect all text passages from the paper that describe, analyze, or discuss that figure. Include enough surrounding context for each passage to be understandable on its own. If a passage discusses multiple figures, include it under each relevant figure subsection. Order figure subsections numerically.

**Rules:**
- Output ONLY the reorganized Markdown. No preamble, no summary, no commentary.
- Do not fabricate content — only reorganize and excerpt text that is present.
- Preserve Markdown formatting (bold, headers, formulas, image links, tables).
- If a paper has no figure references in its text, omit the Figure Descriptions section for that paper.
- Keep each paper's header line (## [Paper N] ...) intact.
- You MUST wrap your entire final output in <output></output> tags. Everything before <output> is internal reasoning and will not be shown to the user.`;
