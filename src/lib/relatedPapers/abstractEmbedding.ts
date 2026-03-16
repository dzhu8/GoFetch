/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Daniel Zhu 2025. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import configManager from "@/server/index";
import modelRegistry from "@/server/providerRegistry";

/**
 * Fetch embeddings for a batch of texts using the default configured embedding model.
 */
export async function getEmbeddings(texts: string[]): Promise<number[][] | null> {
    const defaultModel = configManager.getConfig("preferences.defaultEmbeddingModel");
    if (!defaultModel) return null;

    const { providerId, modelKey } = defaultModel;
    const provider = modelRegistry.getProviderById(providerId);
    if (!provider) return null;

    try {
        const client = await provider.provider.loadEmbeddingModel(modelKey);
        if (!client?.embedDocuments) return null;
        return await client.embedDocuments(texts);
    } catch (err) {
        console.error(`[getEmbeddings] Failed for model ${modelKey}`, err);
        return null;
    }
}

/**
 * Calculate the cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
