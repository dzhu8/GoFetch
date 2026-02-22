import { NextRequest, NextResponse } from "next/server";

const ACADEMIC_DOMAINS = [
     "arxiv.org",
     "science.org",
     "nature.com",
     "springer.com",
     "ieee.org",
     "ieeexplore.ieee.org",
     "acm.org",
     "dl.acm.org",
     "sciencedirect.com",
     "wiley.com",
     "onlinelibrary.wiley.com",
     "plos.org",
     "cell.com",
     "pnas.org",
     "oup.com",
     "academic.oup.com",
     "tandfonline.com",
     "mdpi.com",
     "frontiersin.org",
     "biorxiv.org",
     "medrxiv.org",
     "pubmed.ncbi.nlm.nih.gov",
     "researchgate.net",
];

export interface SearchResult {
     title: string;
     url: string;
     snippet: string;
     authors?: string;
     year?: number;
     venue?: string;
     isAcademic: boolean;
     domain: string;
}

export interface PaperSearchResults {
     query: string;
     results: SearchResult[];
}

export interface RelatedPapersResponse {
     pdfTitle: string;
     results: PaperSearchResults[];
     academicDomains: string[];
     totalCitations: number;
}

function normalisePaperHit(paper: any, fallbackQuery: string): SearchResult {
     let url: string = paper.url || "";
     let domain = "";

     if (paper.externalIds?.ArXiv) {
          url = `https://arxiv.org/abs/${encodeURIComponent(paper.externalIds.ArXiv)}`;
          domain = "arxiv.org";
     } else if (paper.externalIds?.DOI) {
          url = `https://doi.org/${encodeURIComponent(paper.externalIds.DOI)}`;
          domain = "doi.org";
     } else if (paper.externalIds?.PubMed) {
          url = `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(paper.externalIds.PubMed)}`;
          domain = "pubmed.ncbi.nlm.nih.gov";
     }

     if (!domain && url) {
          try {
               domain = new URL(url).hostname.replace(/^www\./, "");
          } catch {
               /* ignore invalid URLs */
          }
     }

     const isAcademic = ACADEMIC_DOMAINS.some((d) => domain.includes(d) || url.includes(d));

     const authorNames: string[] = paper.authors?.slice(0, 3).map((a: any) => a.name) ?? [];
     const authorStr =
          authorNames.length > 0
               ? paper.authors.length > 3
                    ? authorNames.join(", ") + " et al."
                    : authorNames.join(", ")
               : undefined;

     return {
          title: paper.title || fallbackQuery,
          url,
          snippet: paper.abstract
               ? paper.abstract.substring(0, 250) + (paper.abstract.length > 250 ? "\u2026" : "")
               : "",
          authors: authorStr,
          year: paper.year,
          venue: paper.venue || undefined,
          isAcademic,
          domain,
     };
}

/**
 * Resolve a DOI directly via the Semantic Scholar paper lookup endpoint.
 * Returns a single-element array (or empty on failure).
 */
async function lookupByDoi(doi: string): Promise<SearchResult[]> {
     try {
          const fields = "title,abstract,url,externalIds,venue,year,authors";
          const res = await fetch(
               `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${fields}`,
               { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) }
          );
          if (!res.ok) return [];
          const paper = await res.json();
          if (!paper?.paperId) return [];
          return [normalisePaperHit(paper, doi)];
     } catch (err) {
          console.error(`[Related Papers] DOI lookup failed for "${doi}":`, err);
          return [];
     }
}

async function searchSemanticScholar(title: string): Promise<SearchResult[]> {
     try {
          const params = new URLSearchParams({
               query: title,
               limit: "5",
               fields: "title,abstract,url,externalIds,venue,year,authors",
          });

          const res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
               headers: { Accept: "application/json" },
               signal: AbortSignal.timeout(10000),
          });

          if (!res.ok) return [];

          const data = await res.json();
          if (!data.data) return [];

          return data.data.map((paper: any) => normalisePaperHit(paper, title));
     } catch (err) {
          console.error(`[Related Papers] Search failed for "${title}":`, err);
          return [];
     }
}

export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          // terms: search terms (DOI strings or title strings)
          // isDoiFlags: parallel boolean array indicating which terms are DOIs
          const { terms, isDoiFlags, pdfTitle } = body as {
               terms: string[];
               isDoiFlags: boolean[];
               pdfTitle: string;
          };

          if (!terms || !Array.isArray(terms) || terms.length === 0) {
               return NextResponse.json({ error: "No search terms provided." }, { status: 400 });
          }

          const CONCURRENCY = 3;
          const allResults: PaperSearchResults[] = [];
          const academicDomainsSeen = new Set<string>();

          for (let i = 0; i < terms.length; i += CONCURRENCY) {
               const batch = terms.slice(i, i + CONCURRENCY);
               const batchResults = await Promise.all(
                    batch.map(async (term: string, batchIdx: number) => {
                         const globalIdx = i + batchIdx;
                         const isDoi = Array.isArray(isDoiFlags) ? (isDoiFlags[globalIdx] ?? false) : false;
                         const results = isDoi
                              ? await lookupByDoi(term)
                              : await searchSemanticScholar(term);
                         return { query: term, results } satisfies PaperSearchResults;
                    })
               );

               allResults.push(...batchResults);

               for (const pr of batchResults) {
                    for (const r of pr.results) {
                         if (r.isAcademic && r.domain) {
                              academicDomainsSeen.add(r.domain);
                         }
                    }
               }

               // Respect Semantic Scholar rate limits (100 req / 5 min without a key)
               if (i + CONCURRENCY < terms.length) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
               }
          }

          const response: RelatedPapersResponse = {
               pdfTitle,
               results: allResults,
               academicDomains: Array.from(academicDomainsSeen),
               totalCitations: terms.length,
          };

          return NextResponse.json(response);
     } catch (err) {
          console.error("[Related Papers] Error:", err);
          const msg = err instanceof Error ? err.message : "Search failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
