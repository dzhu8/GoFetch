import configManager from "@/server";
import ModelRegistry from "@/server/providerRegistry";
import { NextRequest, NextResponse } from "next/server";
import { ConfigModelProvider } from "@/lib/models/types";

type SaveConfigBody = {
     key: string;
     value: string;
};

export const GET = async (req: NextRequest) => {
     try {
          const values = configManager.currentConfig;
          const fields = configManager.getUIConfigSections();

          const modelProviders = await ModelRegistry.getActiveProviders();

          values.modelProviders = values.modelProviders.map((mp: ConfigModelProvider) => {
               const activeProvider = modelProviders.find((p) => p.id === mp.id);

               return {
                    ...mp,
                    chatModels: activeProvider?.chatModels ?? mp.chatModels,
                    embeddingModels: activeProvider?.embeddingModels ?? mp.embeddingModels,
               };
          });

          return NextResponse.json({
               values,
               fields,
          });
     } catch (err) {
          console.error("Error in getting config: ", err);
          return Response.json({ message: "An error has occurred." }, { status: 500 });
     }
};

export const POST = async (req: NextRequest) => {
     try {
          const body: SaveConfigBody = await req.json();

          if (!body.key || !body.value) {
               return Response.json(
                    {
                         message: "Key and value are required.",
                    },
                    {
                         status: 400,
                    }
               );
          }

          configManager.updateConfig(body.key, body.value);

          return Response.json(
               {
                    message: "Config updated successfully.",
               },
               {
                    status: 200,
               }
          );
     } catch (err) {
          console.error("Error in getting config: ", err);
          return Response.json({ message: "An error has occurred." }, { status: 500 });
     }
};
