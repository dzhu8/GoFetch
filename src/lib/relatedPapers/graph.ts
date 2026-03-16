// ── Constants ────────────────────────────────────────────────────────────────
const BASE = "https://api.semanticscholar.org/graph/v1";
const S2_API_KEY = process.env.S2_API_KEY;

// Public tier: ~1 req/sec. API Key tier: ~100 req/sec (adjust based on your plan)
const MAX_REQUESTS_PER_SECOND = S2_API_KEY ? 80 : 1;

const TOP_N_DEFAULT = 50;
const DEPTH_DEFAULT = 1;
const FRONTIER_BATCH = S2_API_KEY ? 5 : 1; // concurrent neighbour fetches
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

const OA_BASE = "https://api.openalex.org";
const OA_EMAIL = process.env.OPENALEX_EMAIL; // optional — polite pool (higher rate limit)
// Reduce slightly to avoid burst-limit rejection on long crawls.
const OA_REQUESTS_PER_SECOND = OA_EMAIL ? 9 : 4;

// Track S2 failures so we can fall back to OpenAlex automatically.
let _s2unavailableUntil = 0;

// Suppressed 429 count for OA — printed once at the end of each run.
let _oa429Count = 0;
const S2_BACKOFF_MS = 90_000; // 90 s back-off after a 429 / persistent 403

// Disable the API key in-memory once it produces a 403 to prevent every
// subsequent request burning two slots (keyed attempt + keyless retry).
let _s2KeyDisabled = false;

function disableS2Key(): void {
     if (!_s2KeyDisabled) {
          _s2KeyDisabled = true;
          console.warn("[S2] API key disabled for this session (403 received) — falling back to public tier (1 req/s).");
     }
}

function markS2Unavailable(): void {
     if (_s2unavailableUntil > Date.now()) return; // already marked — don't spam / reset timer
     _s2unavailableUntil = Date.now() + S2_BACKOFF_MS;
     console.warn(`[S2] Marked unavailable — switching to OpenAlex for ${S2_BACKOFF_MS / 1000}s.`);
}

function s2IsAvailable(): boolean {
     if (_s2unavailableUntil > Date.now()) return false;
     if (_s2unavailableUntil > 0) {
          console.log(`[S2] Back-off expired — S2 available again.`);
          _s2unavailableUntil = 0;
     }
     return true;
}

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
     /** Total papers in the candidate pool before any pruning */
     totalCandidates: number;
     /** Number of cited papers successfully resolved to Semantic Scholar IDs */
     resolvedCitations: number;
}

/** Configuration for snowball search algorithm. */
export interface SnowballConfig {
     depth?: number;
     maxPapers?: number;
     bcThreshold?: number;
     ccThreshold?: number;
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

// A secondary rate limiter enforcing public-tier speed (1 req/s).
// Used after the API key is disabled so we don't blast the public tier
// at the authenticated-tier rate (80 req/s).
const _publicTierRl = new RateLimiter(1);

// ── Semantic Scholar helpers ──────────────────────────────────────────────────

if (S2_API_KEY) {
     console.log(`[S2] API key loaded — using authenticated tier (${MAX_REQUESTS_PER_SECOND} req/s).`);
} else {
     console.log(`[S2] No API key found — using public tier (${MAX_REQUESTS_PER_SECOND} req/s).`);
}

async function s2get(path: string, rl: RateLimiter): Promise<any | null> {
     if (!s2IsAvailable()) return null;
     const effectiveRl = _s2KeyDisabled ? _publicTierRl : rl;
     await effectiveRl.throttle();
     try {
          const headers: Record<string, string> = { Accept: "application/json" };
          if (S2_API_KEY && !_s2KeyDisabled) headers["x-api-key"] = S2_API_KEY;

          const res = await fetch(`${BASE}${path}`, {
               headers,
               signal: AbortSignal.timeout(15_000),
          });

          if (res.status === 429) {
               markS2Unavailable();
               return null;
          }

          if (res.status === 403 && S2_API_KEY && !_s2KeyDisabled) {
               disableS2Key();
               await _publicTierRl.throttle();
               const fallback = await fetch(`${BASE}${path}`, {
                    headers: { Accept: "application/json" },
                    signal: AbortSignal.timeout(15_000),
               });
               if (!fallback.ok) {
                    if (fallback.status === 403 || fallback.status === 429) markS2Unavailable();
                    console.warn(`[s2get] Fallback Non-OK response: ${fallback.status} ${fallback.statusText} for path: ${path}`);
                    return null;
               }
               return await fallback.json();
          }

          if (!res.ok) {
               console.warn(`[s2get] Non-OK response: ${res.status} ${res.statusText} for path: ${path}`);
               return null;
          }
          return await res.json();
     } catch (err) {
          console.error(`[s2get] Error fetching path: ${path}`, err);
          return null;
     }
}

async function s2post(path: string, body: unknown, rl: RateLimiter): Promise<any | null> {
     if (!s2IsAvailable()) return null;
     const effectiveRl = _s2KeyDisabled ? _publicTierRl : rl;
     await effectiveRl.throttle();
     try {
          const headers: Record<string, string> = {
               Accept: "application/json",
               "Content-Type": "application/json",
          };
          if (S2_API_KEY && !_s2KeyDisabled) headers["x-api-key"] = S2_API_KEY;

          const res = await fetch(`${BASE}${path}`, {
               method: "POST",
               headers,
               body: JSON.stringify(body),
               signal: AbortSignal.timeout(30_000),
          });

          if (res.status === 429) {
               markS2Unavailable();
               return null;
          }

          if (res.status === 403 && S2_API_KEY && !_s2KeyDisabled) {
               disableS2Key();
               await _publicTierRl.throttle();
               const fallback = await fetch(`${BASE}${path}`, {
                    method: "POST",
                    headers: { Accept: "application/json", "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(30_000),
               });
               if (!fallback.ok) {
                    if (fallback.status === 403 || fallback.status === 429) markS2Unavailable();
                    console.warn(`[s2post] Fallback Non-OK response: ${fallback.status} ${fallback.statusText} for path: ${path}`);
                    return null;
               }
               return await fallback.json();
          }

          if (!res.ok) {
               console.warn(`[s2post] Non-OK response: ${res.status} ${res.statusText} for path: ${path}`);
               return null;
          }
          return await res.json();
     } catch (err) {
          console.error(`[s2post] Error posting to path: ${path}`, err);
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
async function s2FetchEdgeIds(
     paperId: string,
     edge: "references" | "citations",
     rl: RateLimiter,
): Promise<Set<string> | null> {
     const ids = new Set<string>();
     const key = edge === "references" ? "citedPaper" : "citingPaper";
     const d = await s2get(
          `/paper/${encodeURIComponent(paperId)}/${edge}?fields=paperId&limit=${MAX_EDGES}`,
          rl,
     );
     if (d === null) return null;
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

// ── OpenAlex helpers ─────────────────────────────────────────────────────────

async function oaGet(path: string, rl: RateLimiter): Promise<any | null> {
     await rl.throttle();
     try {
          const sep = path.includes("?") ? "&" : "?";
          const url = OA_EMAIL
               ? `${OA_BASE}${path}${sep}mailto=${encodeURIComponent(OA_EMAIL)}`
               : `${OA_BASE}${path}`;
          const res = await fetch(url, {
               headers: { Accept: "application/json" },
               signal: AbortSignal.timeout(15_000),
          });
          if (res.status === 429) {
               _oa429Count++;
               return null;
          }
          if (!res.ok) {
               console.warn(`[oaGet] Non-OK response: ${res.status} for path: ${path}`);
               return null;
          }
          return await res.json();
     } catch (err) {
          console.error(`[oaGet] Error for path: ${path}`, err);
          return null;
     }
}

/** Reconstruct abstract text from OpenAlex's inverted-index format. */
function oaReconstructAbstract(inv: Record<string, number[]> | null | undefined): string {
     if (!inv) return "";
     const entries: [number, string][] = [];
     for (const [word, positions] of Object.entries(inv)) {
          for (const pos of positions) entries.push([pos, word]);
     }
     entries.sort((a, b) => a[0] - b[0]);
     return entries.map(([, w]) => w).join(" ");
}

/** Normalise an OpenAlex work object to the same shape expected by the presentation helpers. */
function oaNormalise(work: any, rawId: string): any {
     const doi = work.doi?.replace("https://doi.org/", "");
     const arxiv = work.ids?.arxiv
          ? (work.ids.arxiv as string).replace("https://arxiv.org/abs/", "")
          : undefined;
     const pmid = work.ids?.pmid
          ? String(work.ids.pmid).replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//, "")
          : undefined;
     return {
          paperId: `oa:${rawId}`,
          title: work.title,
          abstract: oaReconstructAbstract(work.abstract_inverted_index),
          url: work.primary_location?.landing_page_url ?? work.doi ?? "",
          externalIds: {
               ...(doi ? { DOI: doi } : {}),
               ...(arxiv ? { ArXiv: arxiv } : {}),
               ...(pmid ? { PubMed: pmid } : {}),
          },
          venue: work.primary_location?.source?.display_name,
          year: work.publication_year,
          authors: work.authorships?.map((a: any) => ({ name: a.author?.display_name ?? "" })) ?? [],
     };
}

/** Resolve a DOI or title against OpenAlex. Returns the raw OA ID (e.g. "W2741809807"). */
async function oaResolveSeed(
     doi: string | undefined,
     title: string,
     rl: RateLimiter,
): Promise<{ id: string; title?: string } | null> {
     if (doi) {
          const d = await oaGet(`/works/doi:${encodeURIComponent(doi)}?select=id,title`, rl);
          if (d?.id) {
               return {
                    id: (d.id as string).replace("https://openalex.org/", ""),
                    title: d.title,
               };
          }
     }
     const params = new URLSearchParams({ search: title, per_page: "3", select: "id,title" });
     const d = await oaGet(`/works?${params}`, rl);
     const results: any[] = d?.results ?? [];
     if (!results.length) return null;
     return {
          id: (results[0].id as string).replace("https://openalex.org/", ""),
          title: results[0].title,
     };
}

async function oaFetchEdgeIds(
     oaId: string, // raw OA ID without "oa:" prefix, e.g. "W2741809807"
     edge: "references" | "citations",
     rl: RateLimiter,
): Promise<Set<string> | null> {
     const ids = new Set<string>();
     if (edge === "references") {
          // referenced_works is embedded in the work object — single call
          const d = await oaGet(`/works/${oaId}?select=referenced_works`, rl);
          if (d === null) return null;
          for (const ref of d?.referenced_works ?? []) {
               const id = (ref as string).replace("https://openalex.org/", "");
               if (id) ids.add(`oa:${id}`);
          }
     } else {
          // Citations need cursor-based pagination
          let cursor: string | undefined = "*";
          let firstCall = true;
          while (ids.size < MAX_EDGES && cursor) {
               const params = new URLSearchParams({
                    filter: `cites:${oaId}`,
                    select: "id",
                    per_page: "200",
                    cursor,
               });
               const d = await oaGet(`/works?${params}`, rl);
               if (d === null) {
                    if (firstCall) return null;
                    break; // keep partial results
               }
               firstCall = false;
               for (const work of d?.results ?? []) {
                    const id = (work.id as string).replace("https://openalex.org/", "");
                    if (id) ids.add(`oa:${id}`);
               }
               cursor = d?.meta?.next_cursor ?? undefined;
               if (!d?.results?.length) break;
          }
     }
     return ids;
}

async function oaBatchMetadata(ids: string[], rl: RateLimiter): Promise<Map<string, any>> {
     const result = new Map<string, any>();
     const rawIds = ids.map((id) => id.replace(/^oa:/, ""));
     for (let i = 0; i < rawIds.length; i += 200) {
          const batch = rawIds.slice(i, i + 200);
          const params = new URLSearchParams({
               filter: `openalex:${batch.join("|")}`
               , per_page: "200",
               select: "id,title,abstract_inverted_index,doi,publication_year,primary_location,authorships,ids",
          });
          const d = await oaGet(`/works?${params}`, rl);
          for (const work of d?.results ?? []) {
               if (!work?.id) continue;
               const rawId = (work.id as string).replace("https://openalex.org/", "");
               result.set(`oa:${rawId}`, oaNormalise(work, rawId));
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

// ── Core algorithm ────────────────────────────────────────────────────────────

async function buildSnowballGraph(
     pdfTitle: string,
     pdfDoi?: string,
     config?: SnowballConfig,
     s2Rl: RateLimiter = new RateLimiter(MAX_REQUESTS_PER_SECOND),
): Promise<RelatedPapersResponse> {
     const depth = config?.depth ?? DEPTH_DEFAULT;
     const maxPapers = config?.maxPapers ?? TOP_N_DEFAULT;
     const bcThreshold = config?.bcThreshold ?? 0;
     const ccThreshold = config?.ccThreshold ?? 0;
     const oaRl = new RateLimiter(OA_REQUESTS_PER_SECOND);

     _oa429Count = 0; // reset per-run counter
     console.log(`[buildSnowballGraph] Starting for title: "${pdfTitle}", depth: ${depth}, max: ${maxPapers}`);

     // ── Phase 1: Resolve seed paper ──────────────────────────────────────
     // Try Semantic Scholar first (DOI then title). Fall back to OpenAlex if
     // S2 is unavailable or returns no result.
     let seedId: string | null = null; // either an S2 hash or "oa:Wxxx"
     let finalPdfTitle = pdfTitle;

     if (s2IsAvailable()) {
          if (pdfDoi) {
               const seed = await s2get(`/paper/DOI:${encodeURIComponent(pdfDoi)}?fields=paperId,title`, s2Rl);
               if (seed?.paperId) {
                    seedId = seed.paperId;
                    if (seed.title) finalPdfTitle = seed.title;
               }
          }
          if (!seedId) seedId = await resolveToId(pdfTitle, false, s2Rl);
          if (seedId) console.log(`[Phase 1] Seed resolved via Semantic Scholar: ${seedId}`);
     }

     if (!seedId) {
          console.log(`[Phase 1] S2 unavailable or no result — trying OpenAlex...`);
          const oa = await oaResolveSeed(pdfDoi, pdfTitle, oaRl);
          if (oa) {
               seedId = `oa:${oa.id}`;
               finalPdfTitle = oa.title ?? pdfTitle;
               console.log(`[Phase 1] Seed resolved via OpenAlex: ${seedId}`);
          }
     }

     if (!seedId) {
          console.warn(`[buildSnowballGraph] Could not resolve seed paper on S2 or OpenAlex.`);
          return {
               pdfTitle: finalPdfTitle,
               pdfDoi,
               seedPaperId: undefined,
               rankedPapers: [],
               totalCandidates: 0,
               resolvedCitations: 0,
          } satisfies RelatedPapersResponse;
     }

     // Provider-dispatched edge fetch: routes to the correct API based on ID prefix.
     const fetchEdge = (id: string, edge: "references" | "citations") =>
          id.startsWith("oa:")
               ? oaFetchEdgeIds(id.slice(3), edge, oaRl)
               : s2FetchEdgeIds(id, edge, s2Rl);

     // ── Phase 2: Fetch R(seed) ────────────────────────────────────────────
     console.log(`[Phase 2] Fetching references for seed ${seedId}...`);
     const initialSet = await fetchEdge(seedId, "references") ?? new Set<string>();
     const initialIds = Array.from(initialSet);
     console.log(`[Phase 2] Found ${initialIds.length} references.`);

     // ── Phase 3: Fetch C(seed) ────────────────────────────────────────────
     const seedCits = await fetchEdge(seedId, "citations") ?? new Set<string>();
     console.log(`[Phase 3] Seed paper has ${seedCits.size} citations.`);

     // ── Phase 4: Frontier expansion ──────────────────────────────────────
     //
     // The candidate pool grows layer by layer outward from the seed:
     //   depth=1 → A∪B (direct refs and citers of seed)
     //   depth=2 → A∪B∪AA∪AB∪BA∪BB, etc.
     //
     // For each candidate layer we crawl their refs+cits so we can compute:
     //   BC(X) = |refs(X) ∩ A|        (bibliographic coupling with seed)
     //   CC(X) = |citers(X) ∩ B|      (co-citation with seed)
     //
     // Layer 0 = {seed}. Layer 1 = A∪B. The loop adds one layer per depth step.
     let currentLayer = new Set([...initialIds, ...Array.from(seedCits)]);
     currentLayer.delete(seedId);
     const visited = new Set<string>();
     const refMap = new Map<string, Set<string>>();
     const citMap = new Map<string, Set<string>>();
     const failedEdges = new Map<string, Set<"references" | "citations">>();
     const MAX_EDGE_RETRIES = 3;

     // BC/CC normalisers are fixed (depend only on A and B, not the crawl depth).
     const bcNorm = Math.max(initialSet.size, 1);
     const ccNorm = Math.max(seedCits.size, 1);

     // Scores accumulated one layer at a time so that depth-1 results are
     // locked in before the depth-2 crawl starts. A paper's BC/CC depends
     // only on A and B (both fixed after Phases 2-3), so scores are final
     // as soon as that paper's own edges are known — scoring layer-by-layer
     // is mathematically equivalent to scoring everything at the end, but
     // prevents transient API failures in later layers from silently zeroing
     // out scores for depth-1 winners.
     const allScored: Array<{ paperId: string; bcScore: number; ccScore: number; score: number }> = [];
     const scoredSet = new Set<string>(); // guards against cross-layer duplicates

     for (let d = 0; d < depth; d++) {
          console.log(`[Phase 4] Crawling layer ${d + 1}/${depth} (${currentLayer.size} papers)...`);
          const toFetch = Array.from(currentLayer).filter((id) => !visited.has(id));
          for (let i = 0; i < toFetch.length; i += FRONTIER_BATCH) {
               await Promise.all(
                    toFetch.slice(i, i + FRONTIER_BATCH).map(async (pid) => {
                         const refs = await fetchEdge(pid, "references");
                         const cits = await fetchEdge(pid, "citations");
                         if (refs !== null) refMap.set(pid, refs);
                         if (cits !== null) citMap.set(pid, cits);
                         if (refs === null || cits === null) {
                              const failed = new Set<"references" | "citations">();
                              if (refs === null) failed.add("references");
                              if (cits === null) failed.add("citations");
                              failedEdges.set(pid, failed);
                         }
                         visited.add(pid);
                    }),
               );
          }

          // Retry failed edge fetches before scoring or expanding to the next layer.
          // This ensures retries happen while results are still fresh and before
          // depth-1 scores are committed.
          for (let attempt = 1; attempt <= MAX_EDGE_RETRIES && failedEdges.size > 0; attempt++) {
               // If S2 is in backoff, wait for it to expire rather than burning retries immediately.
               if (_s2unavailableUntil > Date.now()) {
                    const waitMs = _s2unavailableUntil - Date.now();
                    console.log(`[Phase 4] S2 backoff active — waiting ${Math.ceil(waitMs / 1000)}s before retry ${attempt}/${MAX_EDGE_RETRIES}...`);
                    await new Promise((r) => setTimeout(r, waitMs));
                    _s2unavailableUntil = 0;
               } else {
                    // Brief pause for transient errors (network hiccup, OA throttle, etc.)
                    await new Promise((r) => setTimeout(r, 5_000));
               }
               console.log(`[Phase 4] Retry ${attempt}/${MAX_EDGE_RETRIES}: ${failedEdges.size} papers with failed edges...`);
               const retryEntries = Array.from(failedEdges.entries());
               for (let j = 0; j < retryEntries.length; j += FRONTIER_BATCH) {
                    await Promise.all(
                         retryEntries.slice(j, j + FRONTIER_BATCH).map(async ([pid, edges]) => {
                              if (edges.has("references")) {
                                   const r = await fetchEdge(pid, "references");
                                   if (r !== null) { refMap.set(pid, r); edges.delete("references"); }
                              }
                              if (edges.has("citations")) {
                                   const c = await fetchEdge(pid, "citations");
                                   if (c !== null) { citMap.set(pid, c); edges.delete("citations"); }
                              }
                              if (edges.size === 0) failedEdges.delete(pid);
                         }),
                    );
               }
          }

          // Remove fully-failed papers (no edges resolved at all) from visited.
          let removedCount = 0;
          for (const [pid] of Array.from(failedEdges.entries())) {
               if (!refMap.has(pid) && !citMap.has(pid)) {
                    visited.delete(pid);
                    failedEdges.delete(pid);
                    removedCount++;
               }
          }
          if (removedCount > 0) {
               console.warn(`[Phase 4] Layer ${d + 1}: ${removedCount} fully-failed papers excluded from candidates.`);
          }
          if (failedEdges.size > 0) {
               console.warn(`[Phase 4] Layer ${d + 1}: ${failedEdges.size} papers with partial edge failures (scored conservatively with 0 for missing component).`);
          }

          // ── Score this layer immediately ──────────────────────────────────
          let layerScoredCount = 0;
          for (const c of currentLayer) {
               if (!visited.has(c) || scoredSet.has(c) || c === seedId) continue;
               const refs = refMap.get(c);
               let bcOverlap = 0;
               if (refs) {
                    for (const r of refs) {
                         if (initialSet.has(r)) bcOverlap++;
                    }
               }
               const cits = citMap.get(c);
               let ccOverlap = 0;
               if (cits) {
                    for (const ci of cits) {
                         if (seedCits.has(ci)) ccOverlap++;
                    }
               }
               const bcScore = bcOverlap / bcNorm;
               const ccScore = ccOverlap / ccNorm;
               allScored.push({ paperId: c, bcScore, ccScore, score: 0.5 * bcScore + 0.5 * ccScore });
               scoredSet.add(c);
               layerScoredCount++;
          }
          console.log(`[Phase 4] Layer ${d + 1} scored ${layerScoredCount} candidates (running total: ${allScored.length}).`);

          if (d < depth - 1) {
               // Expand to the next layer: everything discovered so far not yet visited.
               const nextLayer = new Set<string>();
               for (const pid of currentLayer) {
                    refMap.get(pid)?.forEach((id) => nextLayer.add(id));
                    citMap.get(pid)?.forEach((id) => nextLayer.add(id));
               }
               visited.forEach((id) => nextLayer.delete(id));
               nextLayer.delete(seedId);
               currentLayer = nextLayer;
               if (currentLayer.size === 0) break;
          }
     }

     // ── Phase 5: Candidate pool size ──────────────────────────────────────
     const candidateSet = scoredSet;

     console.log(`[Phase 5] Candidate pool size: ${candidateSet.size}`);

     // ── Phase 6: Filter, sort and take top-K ──────────────────────────────
     //
     // BC(X) = |refs(X) ∩ A| / |A|.  CC(X) = |citers(X) ∩ B| / |B|.
     // Scores were committed per-layer above; we only need to filter and rank.
     const scored = allScored
          .filter((s) => s.bcScore >= bcThreshold && s.ccScore >= ccThreshold)
          .sort((a, b) => b.score - a.score);

     const topK = scored.slice(0, maxPapers);

     console.log(`[Phase 6] Scored candidates. Filtered: ${scored.length}, Top-K: ${topK.length}`);

     if (topK.length === 0) {
          console.warn(`[buildSnowballGraph] Zero results after phase 6.`);
          return {
               pdfTitle: finalPdfTitle,
               pdfDoi,
               seedPaperId: seedId,
               rankedPapers: [],
               totalCandidates: candidateSet.size,
               resolvedCitations: initialIds.length,
          } satisfies RelatedPapersResponse;
     }

     // ── Phase 7: Batch-fetch full metadata ────────────────────────────────
     // IDs can be a mix of S2 hashes and "oa:xxx" strings — route each batch
     // to its own API.
     const topKIds = topK.map((c) => c.paperId);
     const s2BatchIds = topKIds.filter((id) => !id.startsWith("oa:"));
     const oaBatchIds = topKIds.filter((id) => id.startsWith("oa:"));

     // If S2 is currently in backoff (e.g. from Phase 4 rate-limiting), wait
     // for the timer to expire before attempting the metadata batch call.
     if (s2BatchIds.length && !s2IsAvailable()) {
          const waitMs = Math.max(0, _s2unavailableUntil - Date.now());
          if (waitMs > 0) {
               console.log(`[Phase 7] S2 in backoff — waiting ${Math.ceil(waitMs / 1000)}s before metadata fetch...`);
               await new Promise<void>((r) => setTimeout(r, waitMs));
               // Reset so s2IsAvailable() returns true
               _s2unavailableUntil = 0;
          }
     }

     console.log(`[Phase 7] Fetching metadata: ${s2BatchIds.length} via S2, ${oaBatchIds.length} via OpenAlex...`);

     const [s2Meta, oaMeta] = await Promise.all([
          s2BatchIds.length ? batchMetadata(s2BatchIds, s2Rl) : Promise.resolve(new Map<string, any>()),
          oaBatchIds.length ? oaBatchMetadata(oaBatchIds, oaRl) : Promise.resolve(new Map<string, any>()),
     ]);

     const metadata = new Map<string, any>([...s2Meta, ...oaMeta]);
     console.log(`[Phase 7] Metadata fetched for ${metadata.size} papers.`);

     // ── Phase 8: Build the final ranked list ─────────────────────────────
     const rankedPapers: RankedPaper[] = topK.flatMap((cand) => {
          const p = metadata.get(cand.paperId);
          if (!p?.title) {
               console.warn(`[Phase 8] No metadata/title for paper: ${cand.paperId}`);
               return [];
          }
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

     if (_oa429Count > 0) {
          console.warn(`[OpenAlex] ${_oa429Count} request(s) returned 429 (rate-limited) during this run.`);
     }
     console.log(`[Phase 8] Final rankedPapers list size: ${rankedPapers.length}`);

     return {
          pdfTitle: finalPdfTitle,
          pdfDoi,
          seedPaperId: seedId,
          rankedPapers,
          totalCandidates: candidateSet.size,
          resolvedCitations: initialIds.length,
     } satisfies RelatedPapersResponse;
}

// ── Public dispatcher ─────────────────────────────────────────────────────────

/**
 * Build a related-papers graph using the specified method.
 * This is the single entry point shared by the Next.js API route and the CLI.
 */
export async function buildRelatedPapersGraph(
     method: GraphConstructionMethod,
     pdfTitle: string,
     pdfDoi?: string,
     config?: SnowballConfig,
): Promise<RelatedPapersResponse> {
     switch (method) {
          case GraphConstructionMethod.Snowball:
          default:
               return buildSnowballGraph(pdfTitle, pdfDoi, config);
     }
}
