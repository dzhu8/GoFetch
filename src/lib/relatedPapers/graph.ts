import db from "@/server/db";
import { paperEdgeCache, paperMetadataCache, paperAbstractEmbeddings } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";
import configManager from "@/server/index";
import modelRegistry from "@/server/providerRegistry";
import { Buffer } from "node:buffer";
import { getEmbeddings, cosineSimilarity } from "./abstractEmbedding";

// ── Constants ────────────────────────────────────────────────────────────────
const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
// Conservative: ~0.65 req/s without key, 9 req/s with key (S2 limit is 10/s).
// The anonymous tier officially allows 1 req/s, but timing jitter often causes
// 429s at exactly 1000 ms intervals — 1500 ms gives comfortable headroom.
const S2_REQUESTS_PER_SECOND = S2_API_KEY ? 9 : 0.65;

const TOP_N_DEFAULT = 50;
const DEPTH_DEFAULT = 1;
const MAX_EDGES = 500;    // cap refs/cits per paper

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

// Suppressed 429 count — printed once at the end of each run.
let _s2429Count = 0;

// ── Paper graph cache ─────────────────────────────────────────────────────────
// Cached edge data and metadata expire after 90 days; academic paper reference
// lists are essentially immutable after publication.
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Per-run cache statistics — reset at the start of each buildSnowballGraph call.
let _edgeCacheHits = 0;
let _edgeApiCalls = 0;
let _metaCacheHits = 0;
let _metaApiCalls = 0;

function edgeCacheGet(paperId: string, edge: "references" | "citations"): Set<string> | null {
     try {
          const row = db.select().from(paperEdgeCache).where(eq(paperEdgeCache.paperId, paperId)).get();
          if (!row || Date.now() - row.fetchedAt > CACHE_TTL_MS) return null;
          const json = edge === "references" ? row.referencesJson : row.citationsJson;
          if (json == null) return null;
          return new Set<string>(JSON.parse(json));
     } catch { return null; }
}

function edgeCacheSet(paperId: string, edge: "references" | "citations", ids: Set<string>): void {
     try {
          const val = JSON.stringify(Array.from(ids));
          const now = Date.now();
          if (edge === "references") {
               db.insert(paperEdgeCache)
                    .values({ paperId, referencesJson: val, citationsJson: null, fetchedAt: now })
                    .onConflictDoUpdate({ target: paperEdgeCache.paperId, set: { referencesJson: val, fetchedAt: now } })
                    .run();
          } else {
               db.insert(paperEdgeCache)
                    .values({ paperId, referencesJson: null, citationsJson: val, fetchedAt: now })
                    .onConflictDoUpdate({ target: paperEdgeCache.paperId, set: { citationsJson: val, fetchedAt: now } })
                    .run();
          }
     } catch { /* non-fatal — cache write failure never breaks the crawl */ }
}

function metaCacheGet(paperId: string): any | null {
     try {
          const row = db.select().from(paperMetadataCache).where(eq(paperMetadataCache.paperId, paperId)).get();
          if (!row || Date.now() - row.fetchedAt > CACHE_TTL_MS) return null;
          return JSON.parse(row.dataJson);
     } catch { return null; }
}

function metaCacheSet(paperId: string, data: any): void {
     try {
          const now = Date.now();
          const values = {
               paperId,
               dataJson: JSON.stringify(data),
               title: data.title || null,
               abstract: data.abstract || null,
               fetchedAt: now,
          };
          db.insert(paperMetadataCache)
               .values(values)
               .onConflictDoUpdate({
                    target: paperMetadataCache.paperId,
                    set: values,
               })
               .run();
     } catch { /* non-fatal */ }
}

// ── Per-model abstract embedding cache ───────────────────────────────────────
// Stores one embedding vector per (S2 paper ID, model key) pair — survives model
// switching so previously embedded papers never need to be re-embedded.

function embCacheGet(paperId: string, modelKey: string): number[] | null {
     try {
          const row = db
               .select()
               .from(paperAbstractEmbeddings)
               .where(and(eq(paperAbstractEmbeddings.paperId, paperId), eq(paperAbstractEmbeddings.modelKey, modelKey)))
               .get();
          if (!row) return null;
          const buf = row.embedding as Buffer;
          return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
     } catch { return null; }
}

function embCacheSet(paperId: string, modelKey: string, vector: number[]): void {
     try {
          const buf = Buffer.from(new Float32Array(vector).buffer);
          const now = Date.now();
          db.insert(paperAbstractEmbeddings)
               .values({ paperId, modelKey, embedding: buf, createdAt: now })
               .onConflictDoUpdate({
                    target: [paperAbstractEmbeddings.paperId, paperAbstractEmbeddings.modelKey],
                    set: { embedding: buf, createdAt: now },
               })
               .run();
     } catch { /* non-fatal */ }
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
     /** Snowball graph depth: 1 = direct ref/citation of seed, 2 = one step further, etc. */
     depth: number;
}

export interface RelatedPapersResponse {
     pdfTitle: string;
     pdfDoi?: string;
     seedPaperId?: string;
     rankedPapers: RankedPaper[];
     /** Total papers in the candidate pool before any pruning */
     totalCandidates: number;
     /** Number of cited papers successfully resolved */
     resolvedCitations: number;
     /** The ranking method used for this run */
     rankMethod: string;
     /** The embedding model key used (only set when rankMethod === "embedding") */
     embeddingModel?: string;
}

/** Configuration for snowball search algorithm. */
export interface SnowballConfig {
     depth?: number;
     maxPapers?: number;
     bcThreshold?: number;
     ccThreshold?: number;
     /**
      * Known Semantic Scholar paper ID for the source paper.
      * When provided, Phase 1 (seed resolution via API) is skipped entirely.
      * The route handler should populate this from `papers.semanticScholarId`.
      */
     seedPaperS2Id?: string;
}

// ── Rate limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
     private nextSlotMs = 0;
     private readonly minIntervalMs: number;

     constructor(maxPerSecond: number) {
          this.minIntervalMs = 1000 / maxPerSecond;
     }

     async throttle(): Promise<void> {
          const now = Date.now();
          const wait = Math.max(0, this.nextSlotMs - now);
          this.nextSlotMs = now + wait + this.minIntervalMs;
          if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
     }
}

// ── Semantic Scholar helpers ─────────────────────────────────────────────────

if (S2_API_KEY) {
     console.log(`[S2] API key loaded — ${S2_REQUESTS_PER_SECOND} req/s.`);
} else {
     console.log(`[S2] No API key configured — anonymous tier (${S2_REQUESTS_PER_SECOND} req/s).`);
}

const S2_MAX_RETRIES = 3;
const S2_BACKOFF_BASE_MS = 2_000;

async function s2Get(path: string, rl: RateLimiter): Promise<any | null> {
     for (let attempt = 0; attempt <= S2_MAX_RETRIES; attempt++) {
          await rl.throttle();
          try {
               const headers: Record<string, string> = { Accept: "application/json" };
               if (S2_API_KEY) headers["x-api-key"] = S2_API_KEY;
               const res = await fetch(`${S2_BASE}${path}`, {
                    headers,
                    signal: AbortSignal.timeout(15_000),
               });
               if (res.status === 429) {
                    _s2429Count++;
                    if (attempt < S2_MAX_RETRIES) {
                         const delay = S2_BACKOFF_BASE_MS * 2 ** attempt;
                         console.warn(`[s2Get] 429 — retry ${attempt + 1}/${S2_MAX_RETRIES} in ${delay}ms for: ${path}`);
                         await new Promise(r => setTimeout(r, delay));
                         continue;
                    }
                    console.warn(`[s2Get] 429 — retries exhausted for: ${path}`);
                    return null;
               }
               if (!res.ok) {
                    console.warn(`[s2Get] Non-OK response: ${res.status} for path: ${path}`);
                    return null;
               }
               return await res.json();
          } catch (err) {
               console.error(`[s2Get] Error for path: ${path}`, err);
               return null;
          }
     }
     return null;
}

async function s2Post(path: string, body: unknown, rl: RateLimiter): Promise<any | null> {
     for (let attempt = 0; attempt <= S2_MAX_RETRIES; attempt++) {
          await rl.throttle();
          try {
               const headers: Record<string, string> = {
                    Accept: "application/json",
                    "Content-Type": "application/json",
               };
               if (S2_API_KEY) headers["x-api-key"] = S2_API_KEY;
               const res = await fetch(`${S2_BASE}${path}`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(30_000),
               });
               if (res.status === 429) {
                    _s2429Count++;
                    if (attempt < S2_MAX_RETRIES) {
                         const delay = S2_BACKOFF_BASE_MS * 2 ** attempt;
                         console.warn(`[s2Post] 429 — retry ${attempt + 1}/${S2_MAX_RETRIES} in ${delay}ms`);
                         await new Promise(r => setTimeout(r, delay));
                         continue;
                    }
                    console.warn(`[s2Post] 429 — retries exhausted`);
                    return null;
               }
               if (!res.ok) {
                    console.warn(`[s2Post] Non-OK response: ${res.status} for path: ${path}`);
                    return null;
               }
               return await res.json();
          } catch (err) {
               console.error(`[s2Post] Error for path: ${path}`, err);
               return null;
          }
     }
     return null;
}

/** Normalise a Semantic Scholar paper object to the shape expected by the presentation helpers. */
function s2Normalise(work: any): any {
     return {
          paperId: work.paperId,
          title: work.title,
          abstract: work.abstract ?? "",
          url: work.url ?? `https://www.semanticscholar.org/paper/${work.paperId}`,
          externalIds: {
               ...(work.externalIds?.DOI ? { DOI: work.externalIds.DOI } : {}),
               ...(work.externalIds?.ArXiv ? { ArXiv: work.externalIds.ArXiv } : {}),
               ...(work.externalIds?.PubMed ? { PubMed: String(work.externalIds.PubMed) } : {}),
          },
          venue: work.venue || undefined,
          year: work.year,
          authors: work.authors?.map((a: any) => ({ name: a.name ?? "" })) ?? [],
     };
}

/** Resolve a DOI or title against Semantic Scholar. Returns the S2 paperId. */
async function s2ResolveSeed(
     doi: string | undefined,
     title: string,
     rl: RateLimiter,
): Promise<{ id: string; title?: string; abstract?: string } | null> {
     if (doi) {
          const d = await s2Get(`/paper/DOI:${encodeURIComponent(doi)}?fields=paperId,title,abstract`, rl);
          if (d?.paperId) return { id: d.paperId, title: d.title, abstract: d.abstract };
     }
     const params = new URLSearchParams({ query: title, limit: "3", fields: "paperId,title,abstract" });
     const d = await s2Get(`/paper/search/match?${params}`, rl);
     const results: any[] = d?.data ?? [];
     if (!results.length) return null;
     return { id: results[0].paperId, title: results[0].title, abstract: results[0].abstract };
}

async function s2FetchEdgeIds(
     s2Id: string,
     edge: "references" | "citations",
     rl: RateLimiter,
): Promise<Set<string> | null> {
     const cached = edgeCacheGet(s2Id, edge);
     if (cached !== null) { _edgeCacheHits++; return cached; }

     const ids = new Set<string>();
     const key = edge === "references" ? "citedPaper" : "citingPaper";
     const d = await s2Get(
          `/paper/${encodeURIComponent(s2Id)}/${edge}?fields=paperId&limit=${MAX_EDGES}`,
          rl,
     );
     if (d === null) return null;
     for (const item of d?.data ?? []) {
          const pid: string | undefined = item[key]?.paperId;
          if (pid) ids.add(pid);
     }
     // Paginate if S2 signals more results
     let next: number | undefined = d?.next;
     while (next && ids.size < MAX_EDGES) {
          const page = await s2Get(
               `/paper/${encodeURIComponent(s2Id)}/${edge}?fields=paperId&limit=${MAX_EDGES}&offset=${next}`,
               rl,
          );
          if (!page) break;
          for (const item of page?.data ?? []) {
               const pid: string | undefined = item[key]?.paperId;
               if (pid) ids.add(pid);
          }
          if (!page?.data?.length) break;
          next = page?.next;
     }
     _edgeApiCalls++;
     edgeCacheSet(s2Id, edge, ids);
     return ids;
}

async function s2BatchMetadata(ids: string[], rl: RateLimiter): Promise<Map<string, any>> {
     const result = new Map<string, any>();
     const needsFetch: string[] = [];
     for (const id of ids) {
          const cached = metaCacheGet(id);
          if (cached !== null) { result.set(id, cached); _metaCacheHits++; }
          else needsFetch.push(id);
     }
     const FIELDS = "title,abstract,year,authors,venue,externalIds,url";
     for (let i = 0; i < needsFetch.length; i += 500) {
          const batch = needsFetch.slice(i, i + 500);
          const data = await s2Post(`/paper/batch?fields=${FIELDS}`, { ids: batch }, rl);
          for (const work of data ?? []) {
               if (!work?.paperId) continue;
               const normalised = s2Normalise(work);
               result.set(work.paperId, normalised);
               metaCacheSet(work.paperId, normalised);
               _metaApiCalls++;
          }
     }
     return result;
}

/**
 * Fetch references AND citations for a batch of papers in a single POST request.
 * Uses POST /paper/batch with fields=references.paperId,citations.paperId so that
 * both edge types for up to 500 papers are retrieved in one API call instead of
 * two individual GETs per paper.
 */
async function s2FetchEdgesBatch(
     ids: string[],
     rl: RateLimiter,
): Promise<{ refMap: Map<string, Set<string>>; citMap: Map<string, Set<string>> }> {
     const refMap = new Map<string, Set<string>>();
     const citMap = new Map<string, Set<string>>();
     const needsFetch: string[] = [];

     for (const id of ids) {
          const cachedRefs = edgeCacheGet(id, "references");
          const cachedCits = edgeCacheGet(id, "citations");
          if (cachedRefs !== null) { refMap.set(id, cachedRefs); _edgeCacheHits++; }
          if (cachedCits !== null) { citMap.set(id, cachedCits); _edgeCacheHits++; }
          if (cachedRefs === null || cachedCits === null) needsFetch.push(id);
     }

     const FIELDS = "references.paperId,citations.paperId";
     for (let i = 0; i < needsFetch.length; i += 500) {
          const batch = needsFetch.slice(i, i + 500);
          const data = await s2Post(`/paper/batch?fields=${FIELDS}`, { ids: batch }, rl);
          for (const paper of data ?? []) {
               if (!paper?.paperId) continue;
               const pid: string = paper.paperId;
               if (!refMap.has(pid)) {
                    const refs = new Set<string>(
                         (paper.references ?? []).map((r: any) => r.paperId).filter(Boolean),
                    );
                    refMap.set(pid, refs);
                    edgeCacheSet(pid, "references", refs);
                    _edgeApiCalls++;
               }
               if (!citMap.has(pid)) {
                    const cits = new Set<string>(
                         (paper.citations ?? []).map((c: any) => c.paperId).filter(Boolean),
                    );
                    citMap.set(pid, cits);
                    edgeCacheSet(pid, "citations", cits);
                    _edgeApiCalls++;
               }
          }
     }

     return { refMap, citMap };
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
): Promise<RelatedPapersResponse> {
     const depth = config?.depth ?? DEPTH_DEFAULT;
     const maxPapers = config?.maxPapers ?? TOP_N_DEFAULT;
     const bcThreshold = config?.bcThreshold ?? 0;
     const ccThreshold = config?.ccThreshold ?? 0;
     const rankMethod = configManager.getConfig("personalization.graphRankMethod") || "bibliographic";
     const s2Rl = new RateLimiter(S2_REQUESTS_PER_SECOND);

     _s2429Count = 0;
     _edgeCacheHits = 0;
     _edgeApiCalls = 0;
     _metaCacheHits = 0;
     _metaApiCalls = 0;
     console.log(`[buildSnowballGraph] Starting for title: "${pdfTitle}", depth: ${depth}, max: ${maxPapers}`);

     // ── Phase 1: Resolve seed paper via Semantic Scholar ────────────────
     // If the route already knows the seed's S2 ID (stored in papers.semanticScholarId),
     // skip the external API lookup entirely and use what's cached.
     let seedId: string | null = config?.seedPaperS2Id ?? null;
     let finalPdfTitle = pdfTitle;
     let seedAbstract: string | undefined;

     if (seedId) {
          // Fast path: S2 ID already known from previous run.
          console.log(`[Phase 1] Using cached S2 seed ID: ${seedId}`);
          const cachedSeedMeta = metaCacheGet(seedId);
          if (cachedSeedMeta?.title) finalPdfTitle = cachedSeedMeta.title;
          if (cachedSeedMeta?.abstract) seedAbstract = cachedSeedMeta.abstract;
     } else {
          // Slow path: resolve via Semantic Scholar API.
          console.log(`[Phase 1] Resolving seed — title: "${pdfTitle.slice(0, 80)}"`);
          const s2 = await s2ResolveSeed(pdfDoi, pdfTitle, s2Rl);
          if (s2) {
               seedId = s2.id;
               finalPdfTitle = s2.title ?? pdfTitle;
               seedAbstract = s2.abstract ?? undefined;
               console.log(`[Phase 1] Seed resolved via Semantic Scholar: ${seedId}`);
          } else {
               console.warn(`[Phase 1] Semantic Scholar returned no result.`);
          }
     }

     if (!seedId) {
          console.warn(`[buildSnowballGraph] Could not resolve seed paper — title: "${pdfTitle}" | DOI: ${pdfDoi ?? "(none)"}. Check that the paper is indexed by Semantic Scholar.`);
          return {
               pdfTitle: finalPdfTitle,
               pdfDoi,
               seedPaperId: undefined,
               rankedPapers: [],
               totalCandidates: 0,
               resolvedCitations: 0,
               rankMethod,
          } satisfies RelatedPapersResponse;
     }

     // ── Phase 2: Fetch R(seed) ────────────────────────────────────────────
     console.log(`[Phase 2] Fetching references for seed ${seedId}...`);
     const initialSet = await s2FetchEdgeIds(seedId, "references", s2Rl) ?? new Set<string>();
     const initialIds = Array.from(initialSet);
     console.log(`[Phase 2] Found ${initialIds.length} references.`);

     // ── Phase 3: Fetch C(seed) ────────────────────────────────────────────
     const seedCits = await s2FetchEdgeIds(seedId, "citations", s2Rl) ?? new Set<string>();
     console.log(`[Phase 3] Seed paper has ${seedCits.size} citations.`);

     // ── Phase 4: Frontier expansion ──────────────────────────────────────
     let currentLayer = new Set([...initialIds, ...Array.from(seedCits)]);
     currentLayer.delete(seedId);
     const visited = new Set<string>();
     const refMap = new Map<string, Set<string>>();
     const citMap = new Map<string, Set<string>>();

     const bcNorm = Math.max(initialSet.size, 1);
     const ccNorm = Math.max(seedCits.size, 1);

     const allScored: Array<{ paperId: string; bcScore: number; ccScore: number; score: number; depth: number }> = [];
     const scoredSet = new Set<string>();

     for (let d = 0; d < depth; d++) {
          console.log(`[Phase 4] Crawling layer ${d + 1}/${depth} (${currentLayer.size} papers)...`);
          const toFetch = Array.from(currentLayer).filter((id) => !visited.has(id));

          // Single batched POST retrieves refs + cits for all layer papers at once.
          const { refMap: batchRefs, citMap: batchCits } = await s2FetchEdgesBatch(toFetch, s2Rl);
          for (const [pid, refs] of batchRefs) refMap.set(pid, refs);
          for (const [pid, cits] of batchCits) citMap.set(pid, cits);
          for (const pid of toFetch) visited.add(pid);

          // Score this layer immediately
          let layerScoredCount = 0;
          for (const c of currentLayer) {
               if (scoredSet.has(c) || c === seedId) continue;
               if (!refMap.has(c) && !citMap.has(c)) continue; // no edge data returned
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
               allScored.push({ paperId: c, bcScore, ccScore, score: 0.5 * bcScore + 0.5 * ccScore, depth: d + 1 });
               scoredSet.add(c);
               layerScoredCount++;
          }
          console.log(`[Phase 4] Layer ${d + 1} scored ${layerScoredCount} candidates (running total: ${allScored.length}).`);

          if (d < depth - 1) {
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
     // If embedding, we take a larger pool (1000) to find best semantic matches.
     // Otherwise, we take the final maxPapers (default 50).
     const initialLimit = rankMethod === "embedding" ? 1000 : maxPapers;

     const scored = allScored
          .filter((s) => s.bcScore >= bcThreshold && s.ccScore >= ccThreshold)
          .sort((a, b) => b.score - a.score);

     const topK = scored.slice(0, initialLimit);
     console.log(`[Phase 6] Scored candidates. Filtered: ${scored.length}, Initial Slice: ${topK.length} (Method: ${rankMethod})`);

     if (topK.length === 0) {
          console.warn(`[buildSnowballGraph] Zero results after phase 6.`);
          return {
               pdfTitle: finalPdfTitle,
               pdfDoi,
               seedPaperId: seedId,
               rankedPapers: [],
               totalCandidates: candidateSet.size,
               resolvedCitations: initialIds.length,
               rankMethod,
          } satisfies RelatedPapersResponse;
     }

     // ── Phase 7: Batch-fetch full metadata ────────────────────────────────
     const topKIds = topK.map((c) => c.paperId);
     console.log(`[Phase 7] Fetching metadata for ${topKIds.length} papers via Semantic Scholar...`);

     const metadata = await s2BatchMetadata(topKIds, s2Rl);
     console.log(
          `[Phase 7] Metadata: ${_metaApiCalls} fetched via API, ${_metaCacheHits} from archive` +
          ` (total: ${metadata.size}).`,
     );
     console.log(
          `[Phase 4] Edge data: ${_edgeApiCalls} papers fetched via API, ${_edgeCacheHits} from archive.`,
     );

     // Brief cooldown after the metadata batch to let the S2 rate-limit window reset
     // before any further API calls (e.g. Phase 9 embedding requests).
     if (!S2_API_KEY) {
          console.log('[Phase 7→8] Pausing 3 s to let S2 rate-limit window reset...');
          await new Promise<void>(r => setTimeout(r, 3000));
     }

     // ── Phase 8: Build the final ranked list ─────────────────────────────
     let rankedPapers: RankedPaper[] = topK.flatMap((cand) => {
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
                    ccScore: cand.ccScore,                    depth: cand.depth,               } satisfies RankedPaper,
          ];
     });

     // ── Optional Phase 9: Embedding-based ranking ────────────────────────
     if (rankMethod === "embedding") {
          console.log(`[Phase 9] Re-ranking ${rankedPapers.length} candidates using embeddings...`);
          const defaultModel = configManager.getConfig("preferences.defaultEmbeddingModel");
          const modelKey = typeof defaultModel === "object" ? defaultModel?.modelKey : null;

          // Resolve seed abstract: use value already captured in Phase 1 (avoids a second API call),
          // or fall back to the metadata cache if Phase 1 was skipped and the abstract wasn't stored.
          let effectiveSeedAbstract = seedAbstract;
          if (!effectiveSeedAbstract && seedId) {
               const cachedSeedMeta = metaCacheGet(seedId);
               if (cachedSeedMeta?.abstract) effectiveSeedAbstract = cachedSeedMeta.abstract;
          }

          if (!effectiveSeedAbstract) {
               console.warn("[Phase 9] No seed abstract available — skipping embedding re-ranking.");
          } else {
               // 1. Get seed embedding — check per-model cache before calling the embedding API.
               let seedVector: number[] | null = seedId && modelKey ? embCacheGet(seedId, modelKey) : null;
               if (!seedVector) {
                    const seedEmbedResult = await getEmbeddings([effectiveSeedAbstract]);
                    if (seedEmbedResult) {
                         seedVector = seedEmbedResult[0];
                         if (seedId && modelKey) embCacheSet(seedId, modelKey, seedVector);
                    }
               }

               if (seedVector) {
                    // 2. Identify abstracts needing embedding — check per-model cache first.
                    const toEmbedIndices: number[] = [];
                    const abstracts: string[] = [];

                    for (let i = 0; i < rankedPapers.length; i++) {
                         const cachedVec = modelKey ? embCacheGet(rankedPapers[i].paperId, modelKey) : null;
                         if (cachedVec) {
                              rankedPapers[i].score = cosineSimilarity(seedVector, cachedVec);
                         } else {
                              const meta = metadata.get(rankedPapers[i].paperId);
                              if (meta?.abstract) {
                                   toEmbedIndices.push(i);
                                   abstracts.push(meta.abstract);
                              } else {
                                   rankedPapers[i].score = 0; // No abstract = no similarity
                              }
                         }
                    }

                    // 3. Batch embed missing ones and persist per model in paper_abstract_embeddings.
                    if (abstracts.length > 0) {
                         const batchResults = await getEmbeddings(abstracts);
                         if (batchResults) {
                              for (let i = 0; i < batchResults.length; i++) {
                                   const rpIndex = toEmbedIndices[i];
                                   const vector = batchResults[i];
                                   rankedPapers[rpIndex].score = cosineSimilarity(seedVector, vector);
                                   if (modelKey) embCacheSet(rankedPapers[rpIndex].paperId, modelKey, vector);
                              }
                         }
                    }

                    // 4. Filter by threshold (using normalized similarity for filtering)
                    // and sort by embedding score
                    const embedThreshold = configManager.getConfig("personalization.snowballEmbeddingThreshold") || 0;
                    
                    // Re-sort by embedding score first to get the true strongest semantic matches
                    rankedPapers = rankedPapers.sort((a, b) => b.score - a.score);

                    // 5. Normalize scores: [lowest_sim, highest_sim] -> [0, 1]
                    const similarities = rankedPapers.map(p => p.score);
                    const minSim = Math.min(...similarities);
                    const maxSim = Math.max(...similarities);
                    const range = maxSim - minSim;

                    if (range > 0) {
                         for (const rp of rankedPapers) {
                              rp.score = (rp.score - minSim) / range;
                         }
                    }

                    // Final filter by threshold and slice to user's maxPapers
                    rankedPapers = rankedPapers
                         .filter(p => p.score >= embedThreshold)
                         .slice(0, maxPapers);
                    
                    // Zero out BC/CC scores — not meaningful for embedding-ranked results
                    for (const rp of rankedPapers) {
                        rp.bcScore = 0;
                        rp.ccScore = 0;
                    }
               }
          }
     }

     if (_s2429Count > 0) {
          console.warn(`[S2] ${_s2429Count} request(s) returned 429 (rate-limited) during this run.`);
     }
     console.log(`[Phase 8/9] Final rankedPapers list size: ${rankedPapers.length}`);

     const usedEmbeddingModel = rankMethod === "embedding"
          ? (() => { const m = configManager.getConfig("preferences.defaultEmbeddingModel"); return typeof m === "object" ? m?.modelKey : null; })()
          : undefined;

     return {
          pdfTitle: finalPdfTitle,
          pdfDoi,
          seedPaperId: seedId,
          rankedPapers,
          totalCandidates: candidateSet.size,
          resolvedCitations: initialIds.length,
          rankMethod,
          embeddingModel: usedEmbeddingModel ?? undefined,
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
