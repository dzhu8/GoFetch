export interface SearxngSearchOptions {
     categories?: string[];
     engines?: string[];
     language?: string;
     pageno?: number;
}

export interface SearxngSearchResult {
     title: string;
     url: string;
     img_src?: string;
     thumbnail_src?: string;
     thumbnail?: string;
     content?: string;
     author?: string;
     iframe_src?: string;
}

const getSearxngURL = (): string =>
     process.env.SEARXNG_API_URL || "http://localhost:8080";

export const searchSearxng = async (
     query: string,
     opts?: SearxngSearchOptions,
): Promise<{ results: SearxngSearchResult[]; suggestions: string[] }> => {
     const searxngURL = getSearxngURL();

     const url = new URL(`${searxngURL}/search?format=json`);
     url.searchParams.append("q", query);

     if (opts) {
          Object.keys(opts).forEach((key) => {
               const value = opts[key as keyof SearxngSearchOptions];
               if (Array.isArray(value)) {
                    url.searchParams.append(key, value.join(","));
                    return;
               }
               url.searchParams.append(key, value as string);
          });
     }

     const res = await fetch(url.toString());

     if (!res.ok) {
          throw new Error(`SearXNG request failed: ${res.status} ${res.statusText}`);
     }

     const data = await res.json();

     return {
          results: (data.results as SearxngSearchResult[]) ?? [],
          suggestions: (data.suggestions as string[]) ?? [],
     };
};
