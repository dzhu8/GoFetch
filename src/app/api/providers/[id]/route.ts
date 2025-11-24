import { NextRequest, NextResponse } from "next/server";
import ModelRegistry from "@/server/providerRegistry";
import crypto from "crypto";

export const PATCH = async (req: NextRequest, { params }: { params: { id: string } }) => {
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

          const body = await req.json();

          // Update the provider with new data
          const updatedProvider = {
               ...provider,
               chatModels: body.chatModels !== undefined ? body.chatModels : provider.chatModels,
               embeddingModels: body.embeddingModels !== undefined ? body.embeddingModels : provider.embeddingModels,
               config: body.config !== undefined ? body.config : provider.config,
          };

          // Regenerate hash
          updatedProvider.hash = crypto
               .createHash("sha256")
               .update(
                    JSON.stringify({
                         id: updatedProvider.id,
                         name: updatedProvider.name,
                         type: updatedProvider.type,
                         config: updatedProvider.config,
                    })
               )
               .digest("hex")
               .substring(0, 16);

          const result = ModelRegistry.updateProvider(updatedProvider);

          return NextResponse.json(
               {
                    message: "Provider updated successfully.",
                    provider: result,
               },
               { status: 200 }
          );
     } catch (err) {
          console.error("Error updating provider:", err);
          return NextResponse.json({ message: "An error has occurred while updating the provider." }, { status: 500 });
     }
};

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
