import { NextResponse } from "next/server";

const DEFAULT_PROTOCOL = process.env.GOFETCH_CLI_PROTOCOL ?? "http";
const DEFAULT_HOST = process.env.GOFETCH_CLI_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.GOFETCH_CLI_PORT ?? 4820);
const CLI_BASE_URL = `${DEFAULT_PROTOCOL}://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const CLI_PROMPT_ENDPOINT = `${CLI_BASE_URL}/selection/prompt`;
const CLI_SELECTION_ENDPOINT = `${CLI_BASE_URL}/selection/latest`;

export async function GET() {
     try {
          const res = await fetch(CLI_SELECTION_ENDPOINT, {
               cache: "no-store",
          });

          if (!res.ok) {
               return NextResponse.json({ error: "CLI helper unavailable" }, { status: 503 });
          }

          const data = await res.json();
          return NextResponse.json(data);
     } catch (error) {
          console.error("Failed to reach CLI helper:", error);
          return NextResponse.json({ error: "CLI helper unreachable" }, { status: 503 });
     }
}

export async function POST() {
     try {
          const res = await fetch(CLI_PROMPT_ENDPOINT, {
               method: "POST",
               cache: "no-store",
          });

          const data = await res.json().catch(() => null);
          if (!res.ok) {
               return NextResponse.json({ error: data?.error ?? "CLI helper unavailable" }, { status: res.status });
          }

          return NextResponse.json(data ?? {});
     } catch (error) {
          console.error("Failed to trigger CLI folder picker:", error);
          return NextResponse.json({ error: "CLI helper unreachable" }, { status: 503 });
     }
}
