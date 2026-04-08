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

**Tips for identifying continuous figure-discussion blocks:**
- In Results sections, each subsection (## heading) typically focuses on one or two figures. All paragraphs under that heading usually belong to the same figure discussion, even if only the first paragraph explicitly names the figure.
- Once a figure is introduced in a paragraph (e.g. "Figure 2A shows…"), subsequent paragraphs continue discussing that same figure until a new section heading appears or a different figure is explicitly introduced. Include these continuation paragraphs — they contain analysis and interpretation of the figure's results.
- Brief inline references in the Introduction or Discussion (e.g. "…as shown in Figure 3") are usually single-sentence mentions. Include the surrounding sentence or two, not the entire paragraph, since the paragraph's main topic is something else.
- Italicized lines like *Fig. 1 | …* are figure captions extracted from the paper, not body-text discussion. You may include them for context under the figure heading, but prioritize collecting the body-text passages that analyze or interpret the figure.

**Rules:**
- Do not fabricate content — only reorganize and excerpt text that is present.
- Preserve Markdown formatting (bold, headers, formulas, image links, tables).
- If a paper has no figure references in its text, omit the Figure Descriptions section for that paper.
- Keep each paper's header line (## [Paper N] ...) intact.
- You MUST wrap your entire final output in <output></output> tags. Everything before <output> is internal reasoning and will not be shown to the user.`;

/**
 * Test prompt: extracts only the first figure's description from the paper text.
 * Useful for validating figure-detection logic on a single figure before running
 * the full organizer.
 */
export const getTestPdfOrganizerPrompt = (
     reconstructedText: string,
): string => `You are a text-processing tool. You do NOT answer questions. You do NOT summarize. You do NOT interpret the user's intent. You ONLY extract text related to the first figure in the provided paper, then output the result. Do not output any preamble, reasoning, or commentary — output ONLY the extracted Markdown.

<paper_text>
${reconstructedText}
</paper_text>

**Task:** Find and extract all passages that reference or discuss the first figure in this paper (typically "Figure 1" or "Fig. 1", including sub-panels like "Figure 1A", "Fig. 1b", etc.). Output a single section headed "### Figure 1" containing all of those passages.

**Tips for identifying continuous figure-discussion blocks:**
- In Results sections, each subsection (## heading) typically focuses on one or two figures. All paragraphs under that heading usually belong to the same figure discussion, even if only the first paragraph explicitly names the figure.
- Once a figure is introduced in a paragraph (e.g. "Figure 1A shows…"), subsequent paragraphs continue discussing that same figure until a new section heading appears or a different figure is explicitly introduced. Include these continuation paragraphs — they contain analysis and interpretation of the figure's results.
- Brief inline references in the Introduction or Discussion (e.g. "…as shown in Figure 1") are usually single-sentence mentions. Include the surrounding sentence or two, not the entire paragraph, since the paragraph's main topic is something else.
- Italicized lines like *Fig. 1 | …* are figure captions extracted from the paper, not body-text discussion. You may include them for context under the figure heading, but prioritize collecting the body-text passages that analyze or interpret the figure.

**Rules:**
- Only extract text related to Figure 1 (or Fig. 1). Ignore all other figures.
- Do not fabricate content — only extract and excerpt text that is present.
- Preserve Markdown formatting (bold, headers, formulas, image links, tables).
- Include enough surrounding context for each passage to be understandable on its own.
- Output the result directly — no wrapping tags needed.`;
