import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
     // CLI routes are intentionally public API endpoints
     if (req.nextUrl.pathname.startsWith("/api/cli")) {
          return NextResponse.next();
     }

     // Block external requests to internal API routes
     const origin = req.headers.get("origin") || req.headers.get("referer") || "";
     const allowed = req.nextUrl.origin;

     if (!origin.startsWith(allowed)) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
     }

     return NextResponse.next();
}

export const config = {
     matcher: "/api/:path*",
};
