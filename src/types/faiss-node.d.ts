/**
 * Type declarations for faiss-node module.
 *
 * faiss-node is a Node.js binding for Facebook AI Similarity Search (FAISS).
 * Install with: npm install faiss-node
 *
 * @see https://github.com/ewfian/faiss-node
 */
declare module "faiss-node" {
     /** Search result object. */
     export interface SearchResult {
          /** The distances of the nearest neighbors found, size n*k. */
          distances: number[];
          /** The labels of the nearest neighbors found, size n*k. */
          labels: number[];
     }

     /** FAISS metric types */
     export enum MetricType {
          METRIC_INNER_PRODUCT = 0,
          METRIC_L2 = 1,
          METRIC_L1 = 2,
          METRIC_Linf = 3,
          METRIC_Lp = 4,
          METRIC_Canberra = 20,
          METRIC_BrayCurtis = 21,
          METRIC_JensenShannon = 22,
          METRIC_Jaccard = 23,
     }

     /**
      * Base Index class.
      * Index that stores vectors and performs similarity search.
      */
     export class Index {
          constructor(d: number);

          /** Returns the number of vectors currently indexed. */
          ntotal(): number;

          /** Returns the dimensionality of vectors. */
          getDimension(): number;

          /** Returns whether training is required/completed. */
          isTrained(): boolean;

          /** Add n vectors of dimension d to the index. */
          add(x: number[]): void;

          /** Train the index with vectors. */
          train(x: number[]): void;

          /** Query vectors and return k nearest neighbors. */
          search(x: number[], k: number): SearchResult;

          /** Write index to a file. */
          write(fname: string): void;

          /** Write index to buffer. */
          toBuffer(): Buffer;

          /** Read index from a file. */
          static read(fname: string): Index;

          /** Read index from buffer. */
          static fromBuffer(src: Buffer): Index;

          /**
           * Construct an index from factory descriptor.
           * @param dims Vector dimension
           * @param descriptor Factory descriptor (e.g., "Flat", "HNSW32,Flat", "IVF100,Flat")
           * @param metric Metric type (defaults to L2)
           */
          static fromFactory(dims: number, descriptor: string, metric?: MetricType): Index;

          /** Merge another index into this one. */
          mergeFrom(otherIndex: Index): void;

          /** Remove IDs from the index. */
          removeIds(ids: number[]): number;
     }

     /**
      * IndexFlatL2 Index.
      * Stores full vectors and performs squared L2 search.
      */
     export class IndexFlatL2 extends Index {
          static read(fname: string): IndexFlatL2;
          static fromBuffer(src: Buffer): IndexFlatL2;
          mergeFrom(otherIndex: IndexFlatL2): void;
     }

     /**
      * IndexFlatIP Index.
      * Stores full vectors and performs maximum inner product search.
      */
     export class IndexFlatIP extends Index {
          static read(fname: string): IndexFlatIP;
          static fromBuffer(src: Buffer): IndexFlatIP;
          mergeFrom(otherIndex: IndexFlatIP): void;
     }
}
