import { Document } from "@langchain/core/documents";

export interface AcademicSearchChunk {
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

export interface AcademicSearchInput {
     query: string;
     history: Array<[string, string]>;
     chatModel: {
          providerId: string;
          key: string;
     };
     systemInstructions?: string;
     chatId: string;
     messageId: string;
}

export interface AcademicSource extends Document {
     metadata: {
          title: string;
          url: string;
          [key: string]: any;
     };
}
