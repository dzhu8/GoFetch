/**
 * Computes the cosine similarity between two vectors.
 * Returns a value between -1 and 1, where 1 means identical direction.
 */
export default function computeSimilarity(x: number[], y: number[]): number {
     if (x.length !== y.length) {
          throw new Error("Vectors must have the same length");
     }

     let dotProduct = 0;
     let normX = 0;
     let normY = 0;

     for (let i = 0; i < x.length; i++) {
          dotProduct += x[i] * y[i];
          normX += x[i] * x[i];
          normY += y[i] * y[i];
     }

     const magnitude = Math.sqrt(normX) * Math.sqrt(normY);

     if (magnitude === 0) {
          return 0;
     }

     return dotProduct / magnitude;
}
