export interface WebSearchChunk {
     content: string;
     metadata: {
          title: string;
          url: string;
     };
}

export interface ClassifierOutput {
     standaloneQuery: string;
     searchQueries: string[];
}
