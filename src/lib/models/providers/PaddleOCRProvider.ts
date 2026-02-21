import { ConfigModelProvider, Model } from "@/lib/models/types";
import { BaseModelProvider } from "./BaseModelProvider";

export const PADDLEOCR_CURATED_MODELS: Array<{
     name: string;
     description: string;
}> = [
     {
          name: "PaddleOCR-VL",
          description: "High-performance document OCR — installed via pip (NVIDIA GPU + CUDA required)",
     },
];

export class PaddleOCRProvider extends BaseModelProvider {
     getAvailableChatModels(): Model[] {
          return [];
     }

     getAvailableEmbeddingModels(): Model[] {
          return [];
     }

     getAvailableOCRModels(): Model[] {
          return this.definition.ocrModels ?? [];
     }

     async loadChatModel(_modelKey: string): Promise<never> {
          throw new Error("PaddleOCR provider does not support chat models.");
     }

     async loadEmbeddingModel(_modelKey: string): Promise<never> {
          throw new Error("PaddleOCR provider does not support embedding models.");
     }

     async loadOCRModel(modelKey: string): Promise<{ modelKey: string; providerType: "paddleocr" }> {
          this.assertModelConfigured(modelKey, this.getAvailableOCRModels());
          return { modelKey, providerType: "paddleocr" };
     }
}
