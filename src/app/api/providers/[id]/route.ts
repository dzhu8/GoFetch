import { NextRequest, NextResponse } from "next/server";
import ModelRegistry from "@/server/providerRegistry";

export const DELETE = async (req: NextRequest, { params }: { params: { id: string } }) => {
     try {
          const { id } = await params;

          if (!id) {
               return NextResponse.json({ message: "Provider ID is required." }, { status: 400 });
          }

          // Check if provider exists
          const provider = ModelRegistry.getProviderById(id);
          if (!provider) {
               return NextResponse.json({ message: "Provider not found." }, { status: 404 });
          }

          ModelRegistry.removeProvider(id);

          return NextResponse.json(
               {
                    message: "Provider deleted successfully.",
               },
               { status: 200 }
          );
     } catch (err) {
          console.error("Error deleting provider:", err);
          return NextResponse.json({ message: "An error has occurred while deleting the provider." }, { status: 500 });
     }
};
