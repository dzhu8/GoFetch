export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getSearxngURL = (): string =>
     process.env.SEARXNG_API_URL || "http://localhost:8080";

export const GET = async () => {
     try {
          const res = await fetch(getSearxngURL(), {
               signal: AbortSignal.timeout(3000),
          });

          if (!res.ok) {
               return Response.json(
                    { available: false, error: `SearXNG responded with ${res.status}` },
                    { status: 503 },
               );
          }

          return Response.json({ available: true });
     } catch {
          return Response.json(
               { available: false, error: "SearXNG is not reachable" },
               { status: 503 },
          );
     }
};
