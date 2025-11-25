import { NextRequest, NextResponse } from "next/server";
import monitorService from "@/server/monitoring/monitorService";

/*
Note this is redundant but remains active for manual control if needed. 
*/

export async function GET() {
     return NextResponse.json({ monitored: monitorService.list() });
}

export async function POST(req: NextRequest) {
     try {
          const { folderName, enabled } = (await req.json()) as { folderName?: string; enabled?: boolean };

          if (!folderName || typeof enabled !== "boolean") {
               return NextResponse.json({ error: "folderName and enabled are required." }, { status: 400 });
          }

          if (enabled) {
               monitorService.enable(folderName);
          } else {
               monitorService.disable(folderName);
          }

          return NextResponse.json({ monitored: monitorService.list() });
     } catch (error) {
          console.error("Failed to update monitoring state:", error);
          return NextResponse.json(
               { error: error instanceof Error ? error.message : "Failed to update monitoring state." },
               { status: 500 }
          );
     }
}
