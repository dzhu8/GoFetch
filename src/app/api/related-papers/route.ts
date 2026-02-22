import { NextRequest, NextResponse } from "next/server";
import configManager from "@/server";

// ── Constants ────────────────────────────────────────────────────────────────
const BASE = "https://api.semanticscholar.org/graph/v1";
const MAX_REQUESTS_PER_SECOND = 1000;
const TOP_N = 50;
const RESOLVE_BATCH = 5;  // concurrent citation resolutions
const FRONTIER_BATCH = 3; // concurrent depth-1 neighbour fetches
const MAX_EDGES = 500;    // cap refs/cits per paper (first page of API)

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

const METADATA_FIELDS = "paperId,title,abstract,url,externalIds,venue,year,authors";

// ── Public types ─────────────────────────────────────────────────────────────

export enum GraphConstructionMethod {
     Snowball = "snowball",
}

export interface RankedPaper {
     paperId: string;
     title: string;
     url: string;
     snippet: string;
     authors?: string;
     year?: number;
     venue?: string;
     domain: string;
     isAcademic: boolean;
     /** Combined relevance score in [0, 1] */
     score: number;
     /** Bibliographic-coupling component */
     bcScore: number;
     /** Co-citation proxy component */
     ccScore: number;
}

export interface RelatedPapersResponse {
     pdfTitle: string;
     pdfDoi?: string;
     seedPaperId?: string;
     rankedPapers: RankedPaper[];
     /** Total papers in the candidate pool before top-N pruning */
     totalCandidates: number;
     /** Number of cited papers successfully resolved to Semantic Scholar IDs */
     resolvedCitations: number;
}

// ── Rate limiter ─────────────────────────────────────────────────────────────

/**
 * Serialises API slots atomically so that concurrent callers are queued rather
 * than all firing at once, keeping throughput at or below maxPerSecond.
 */
class RateLimiter {
     private nextSlotMs = 0;
     private readonly minIntervalMs: number;

     constructor(maxPerSecond: number) {
          this.minIntervalMs = 1000 / maxPerSecond;
     }

     async throttle(): Promise<void> {
          const now = Date.now();
          const wait = Math.max(0, this.nextSlotMs - now);
          // Reserve the next slot atomically before sleeping so concurrent
          // callers each get a unique slot instead of reading the same value.
          this.nextSlotMs = now + wait + this.minIntervalMs;
          if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
     }
}

// ── Semantic Scholar helpers ──────────────────────────────────────────────────

async function s2get(path: string, rl: RateLimiter): Promise<any | null> {
     await rl.throttle();
     try {
          const res = await fetch(`${BASE}${path}`, {
               headers: { Accept: "application/json" },
               signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return null;
          return await res.json();
     } catch {
          return null;
     }
}

async function s2post(path: string, body: unknown, rl: RateLimiter): Promise<any | null> {
     await rl.throttle();
     try {
          const res = await fetch(`${BASE}${path}`, {
               method: "POST",
               headers: { Accept: "application/json", "Content-Type": "application/json" },
               body: JSON.stringify(body),
               signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) return null;
          return await res.json();
     } catch {
          return null;
     }
}

/**
 * Resolve a DOI or OCR-extracted title string to a Semantic Scholar paperId.
 * For title searches, S2 returns results sorted by relevance; the first result
 * is taken.  Deduplication by DOI is applied when multiple hits share the same
 * underlying paper (e.g. preprint + journal version).
 */
async function resolveToId(term: string, isDoi: boolean, rl: RateLimiter): Promise<string | null> {
     if (isDoi) {
          const d = await s2get(`/paper/DOI:${encodeURIComponent(term)}?fields=paperId`, rl);
          return d?.paperId ?? null;
     }
     const params = new URLSearchParams({ query: term, limit: "5", fields: "paperId,title,year,externalIds" });
     const d = await s2get(`/paper/search?${params}`, rl);
     const hits: any[] = d?.data ?? [];
     if (!hits.length) return null;
     // Dedup by DOI: skip duplicate hits that refer to the same underlying work.
     const seenDois = new Set<string>();
     for (const hit of hits) {
          const doi: string | undefined = hit.externalIds?.DOI;
          if (doi) {
               if (seenDois.has(doi)) continue;
               seenDois.add(doi);
          }
          return hit.paperId;
     }
     return hits[0].paperId;
}

/**
 * Fetch the set of paper IDs on one edge direction of a paper.
 *   references → papers this paper cites      (citedPaper field)
 *   citations  → papers that cite this paper  (citingPaper field)
 */
async function fetchEdgeIds(
     paperId: string,
     edge: "references" | "citations",
     rl: RateLimiter,
): Promise<Set<string>> {
     const ids = new Set<string>();
     const key = edge === "references" ? "citedPaper" : "citingPaper";
     const d = await s2get(
          `/paper/${encodeURIComponent(paperId)}/${edge}?fields=paperId&limit=${MAX_EDGES}`,
          rl,
     );
     for (const item of d?.data ?? []) {
          const id: string | undefined = item[key]?.paperId;
          if (id) ids.add(id);
     }
     return ids;
}

/** Batch-fetch full metadata for up to 500 paper IDs per POST /paper/batch call. */
async function batchMetadata(ids: string[], rl: RateLimiter): Promise<Map<string, any>> {
     const result = new Map<string, any>();
     for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500);
          const data = await s2post(`/paper/batch?fields=${METADATA_FIELDS}`, { ids: batch }, rl);
          for (const p of data ?? []) {
               if (p?.paperId) result.set(p.paperId, p);
          }
     }
     return result;
}

// ── Presentation helpers ──────────────────────────────────────────────────────

function paperUrl(p: any): string {
     if (p.externalIds?.ArXiv) return `https://arxiv.org/abs/${p.externalIds.ArXiv}`;
     if (p.externalIds?.DOI) return `https://doi.org/${encodeURIComponent(p.externalIds.DOI)}`;
     if (p.externalIds?.PubMed) return `https://pubmed.ncbi.nlm.nih.gov/${p.externalIds.PubMed}`;
     return p.url ?? "";
}

function paperDomain(p: any): string {
     if (p.externalIds?.ArXiv) return "arxiv.org";
     if (p.externalIds?.DOI) return "doi.org";
     if (p.externalIds?.PubMed) return "pubmed.ncbi.nlm.nih.gov";
     try {
          return new URL(p.url ?? "").hostname.replace(/^www\./, "");
     } catch {
          return "";
     }
}

function paperAuthors(p: any): string | undefined {
     const names: string[] = p.authors?.slice(0, 3).map((a: any) => a.name) ?? [];
     if (!names.length) return undefined;
     return p.authors.length > 3 ? `${names.join(", ")} et al.` : names.join(", ");
}

// ── Main logic ────────────────────────────────────────────────────────────────

async function buildSnowballGraph(
     terms: string[],
     isDoiFlags: boolean[],
     pdfTitle: string,
     pdfDoi?: string,
     rl: RateLimiter = new RateLimiter(MAX_REQUESTS_PER_SECOND),
): Promise<RelatedPapersResponse> {
     // ── Phase 1: Resolve seed paper ──────────────────────────────────────
     // If we have a DOI, look it up directly for a canonical paperId + clean
     // title from Semantic Scholar.  Fall back to title search when absent.
     let seedPaperId: string | null = null;
     let finalPdfTitle = pdfTitle;

     if (pdfDoi) {
          const seed = await s2get(
               `/paper/DOI:${encodeURIComponent(pdfDoi)}?fields=paperId,title`,
               rl,
          );
          if (seed?.paperId) {
               seedPaperId = seed.paperId;
               if (seed.title) finalPdfTitle = seed.title;
          }
     }
     if (!seedPaperId) {
          seedPaperId = await resolveToId(pdfTitle, false, rl);
     }

     // ── Phase 2: Resolve citations → R(seed) paper IDs ──────────────────
     // Process in small concurrent batches to bound simultaneous requests.
     const depth1Ids: string[] = [];
     for (let i = 0; i < terms.length; i += RESOLVE_BATCH) {
          const ids = await Promise.all(
               terms
                    .slice(i, i + RESOLVE_BATCH)
                    .map((t, j) => resolveToId(t, isDoiFlags[i + j] ?? false, rl)),
          );
          for (const id of ids) if (id) depth1Ids.push(id);
     }

     const depth1Set = new Set(depth1Ids);

     // ── Phase 3: Fetch C(seed) ────────────────────────────────────────────
     // C(seed) = set of paper IDs that cite the seed paper.  Used for the
     // co-citation scoring component.
     const seedCits = seedPaperId
          ? await fetchEdgeIds(seedPaperId, "citations", rl)
          : new Set<string>();

     // ── Phase 4: Frontier loop ────────────────────────────────────────────
     // For every depth-1 paper p, fetch:
     //   refMap[p]  = R(p)  papers that p cites        (backward edges)
     //   citMap[p]  = C(p)  papers that cite p         (forward edges)
     // Each paper does two sequential API calls; up to FRONTIER_BATCH papers
     // run concurrently, so the rate limiter slots 2×FRONTIER_BATCH calls
     // per iteration.
     const refMap = new Map<string, Set<string>>();
     const citMap = new Map<string, Set<string>>();

     for (let i = 0; i < depth1Ids.length; i += FRONTIER_BATCH) {
          await Promise.all(
               depth1Ids.slice(i, i + FRONTIER_BATCH).map(async (pid) => {
                    const refs = await fetchEdgeIds(pid, "references", rl);
                    const cits = await fetchEdgeIds(pid, "citations", rl);
                    refMap.set(pid, refs);
                    citMap.set(pid, cits);
               }),
          );
     }

     // ── Phase 5: Build candidate pool ────────────────────────────────────
     // Candidates = ∪ R(p) ∪ C(p) for p ∈ depth-1, minus depth-1 and seed.
     const candidateSet = new Set<string>();
     for (const map of [refMap, citMap]) {
          for (const ids of map.values()) {
               for (const id of ids) {
                    if (!depth1Set.has(id) && id !== seedPaperId) {
                         candidateSet.add(id);
                    }
               }
          }
     }

     // ── Phase 6: Score candidates ─────────────────────────────────────────
     const bcHits = new Map<string, number>();
     const ccHits = new Map<string, number>();

     for (const cits of citMap.values()) {
          for (const c of cits) {
               if (candidateSet.has(c)) bcHits.set(c, (bcHits.get(c) ?? 0) + 1);
          }
     }
     for (const refs of refMap.values()) {
          for (const c of refs) {
               if (candidateSet.has(c)) ccHits.set(c, (ccHits.get(c) ?? 0) + 1);
          }
     }

     const rSeedSize = Math.max(depth1Ids.length, 1); // guard against /0

     const scored = Array.from(candidateSet)
          .map((c) => {
               const bcOverlap = bcHits.get(c) ?? 0;
               const ccOverlap = Math.min(
                    (ccHits.get(c) ?? 0) + (seedCits.has(c) ? 1 : 0),
                    rSeedSize, // clamp so a single paper cannot dominate
               );
               const bcScore = bcOverlap / rSeedSize;
               const ccScore = ccOverlap / rSeedSize;
               return { paperId: c, bcScore, ccScore, score: 0.5 * bcScore + 0.5 * ccScore };
          })
          .sort((a, b) => b.score - a.score);

     const topK = scored.slice(0, TOP_N);

     if (topK.length === 0) {
          return {
               pdfTitle: finalPdfTitle,
               pdfDoi,
               seedPaperId: seedPaperId ?? undefined,
               rankedPapers: [],
               totalCandidates: candidateSet.size,
               resolvedCitations: depth1Ids.length,
          } satisfies RelatedPapersResponse;
     }

     // ── Phase 7: Batch-fetch full metadata for top-N candidates ──────────
     const metadata = await batchMetadata(
          topK.map((c) => c.paperId),
          rl,
     );

     // ── Phase 8: Build the final ranked list ─────────────────────────────
     const rankedPapers: RankedPaper[] = topK.flatMap((cand) => {
          const p = metadata.get(cand.paperId);
          if (!p?.title) return [];
          const domain = paperDomain(p);
          const url = paperUrl(p);
          return [
               {
                    paperId: cand.paperId,
                    title: p.title,
                    url,
                    snippet: p.abstract
                         ? p.abstract.slice(0, 250) + (p.abstract.length > 250 ? "…" : "")
                         : "",
                    authors: paperAuthors(p),
                    year: p.year,
                    venue: p.venue || undefined,
                    domain,
                    isAcademic: ACADEMIC_DOMAINS.some((d) => domain.includes(d) || url.includes(d)),
                    score: cand.score,
                    bcScore: cand.bcScore,
                    ccScore: cand.ccScore,
               } satisfies RankedPaper,
          ];
     });

     return {
          pdfTitle: finalPdfTitle,
          pdfDoi,
          seedPaperId: seedPaperId ?? undefined,
          rankedPapers,
          totalCandidates: candidateSet.size,
          resolvedCitations: depth1Ids.length,
     } satisfies RelatedPapersResponse;
}

export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          const { terms, isDoiFlags, pdfTitle, pdfDoi, method } = body as {
               terms: string[];
               isDoiFlags: boolean[];
               pdfTitle: string;
               pdfDoi?: string;
               method?: GraphConstructionMethod;
          };

          if (!terms?.length) {
               return NextResponse.json({ error: "No search terms provided." }, { status: 400 });
          }

          // Use method from payload if provided, otherwise fallback to personalization setting, default to Snowball.
          const activeMethod =
               method ??
               configManager.getConfig("personalization.graphConstructionMethod", GraphConstructionMethod.Snowball);

          let response: RelatedPapersResponse;

          switch (activeMethod) {
               case GraphConstructionMethod.Snowball:
               default:
                    response = await buildSnowballGraph(terms, isDoiFlags, pdfTitle, pdfDoi);
                    break;
          }

          return NextResponse.json(response);
     } catch (err) {
          console.error("[Related Papers] Error:", err);
          const msg = err instanceof Error ? err.message : "Search failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
