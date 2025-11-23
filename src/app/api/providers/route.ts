import { NextRequest, NextResponse } from "next/server";
import ModelRegistry from "@/server/providerRegistry";
import { ConfigModelProvider } from "@/lib/models/types";
import crypto from "crypto";

export const GET = async (req: NextRequest) => {
     try {
          const providers = await ModelRegistry.getActiveProviders();

          return NextResponse.json({
               providers,
          });
     } catch (err) {
          console.error("Error fetching providers:", err);
          return NextResponse.json({ message: "An error has occurred while fetching providers." }, { status: 500 });
     }
};

export const POST = async (req: NextRequest) => {
     try {
          const body = await req.json();

          if (!body.name || !body.type) {
               return NextResponse.json({ message: "Provider name and type are required." }, { status: 400 });
          }

          // Generate a unique ID for the new provider
          const id = `${body.type.toLowerCase()}-${Date.now()}`;

          // Generate a hash for the provider configuration
          const hash = crypto
               .createHash("sha256")
               .update(JSON.stringify({ id, name: body.name, type: body.type, config: body.config || {} }))
               .digest("hex")
               .substring(0, 16);

          const newProvider: ConfigModelProvider = {
               id,
               name: body.name,
               type: body.type.toLowerCase(),
               chatModels: body.chatModels || [],
               embeddingModels: body.embeddingModels || [],
               config: body.config || {},
               hash,
          };

          const addedProvider = ModelRegistry.addProvider(newProvider);

          return NextResponse.json(
               {
                    message: "Provider added successfully.",
                    provider: addedProvider,
               },
               { status: 201 }
          );
     } catch (err) {
          console.error("Error adding provider:", err);

          if (err instanceof Error && err.message.includes("already exists")) {
               return NextResponse.json({ message: err.message }, { status: 409 });
          }

          return NextResponse.json({ message: "An error has occurred while adding the provider." }, { status: 500 });
     }
};
