import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { Document } from "@langchain/core/documents";

import { BaseSearchAgent, BaseSearchAgentConfig, BasicChainInput, SearchRetrieverResult } from "./baseSearchAgent";
import FileLinksOutputParser from "../outputParsers/fileLinksOutputParser";
import LineOutputParser from "../outputParsers/lineOutputParser";

import { getDocumentsFromSnippets } from "../utils/snippetRetriever";
import { HNSWSearch } from "./HNSWSearch";
import modelRegistry from "@/server/providerRegistry";
import configManager from "@/server/index";

export interface CodeSearchAgentConfig extends BaseSearchAgentConfig {
     maxNDocuments: number;
     activeEngines: string[];
     /** Defaults to true since HNSWSearch already ranks results */
     skipRerank?: boolean;
}

// Helper to get query embedding using the configured default model
async function embedQuery(query: string): Promise<number[]> {
     const defaultEmbeddingModel = configManager.getConfig("preferences.defaultEmbeddingModel");

     if (!defaultEmbeddingModel) {
          throw new Error("No default embedding model configured");
     }

     const { providerId, modelKey } =
          typeof defaultEmbeddingModel === "object" ? defaultEmbeddingModel : { providerId: null, modelKey: null };

     if (!providerId || !modelKey) {
          throw new Error("Invalid default embedding model configuration");
     }

     const provider = modelRegistry.getProviderById(providerId);
     if (!provider) {
          throw new Error(`Provider ${providerId} not found`);
     }

     const embeddingClient = await provider.provider.loadEmbeddingModel(modelKey);
     const [vector] = await embeddingClient.embedDocuments([query]);

     return vector;
}

class CodeSearchAgent extends BaseSearchAgent {
     declare protected config: CodeSearchAgentConfig;

     constructor(config: CodeSearchAgentConfig) {
          // Default skipRerank to true since HNSWSearch already ranks results
          super({ ...config, skipRerank: config.skipRerank ?? true });
          this.config = { ...config, skipRerank: config.skipRerank ?? true };
     }

     /**
      * Implementation of the search retriever chain for code search.
      * The folderNames are passed via searchRetrieverChainArgs from searchAndAnswer.
      */
     protected async createSearchRetrieverChain(
          llm: BaseChatModel,
          folderNames: string[] = []
     ): Promise<RunnableSequence<BasicChainInput, SearchRetrieverResult>> {
          (llm as unknown as ChatOpenAI).temperature = 0;

          // Capture folderNames in closure for use in the lambda
          const capturedFolderNames = folderNames;

          return RunnableSequence.from([
               ChatPromptTemplate.fromMessages([
                    ["system", this.config.queryGeneratorPrompt],
                    ...this.config.queryGeneratorFewShots,
                    [
                         "user",
                         `
                         <conversation>
                         {chat_history}
                         </conversation>

                         <query>
                         {query}
                         </query>
                         `,
                    ],
               ]),
               llm,
               this.strParser,
               RunnableLambda.from(async (llmOutput: string): Promise<SearchRetrieverResult> => {
                    const fileLinksOutputParser = new FileLinksOutputParser({
                         key: "links",
                    });

                    const questionOutputParser = new LineOutputParser({
                         key: "question",
                    });

                    const fileLinks = await fileLinksOutputParser.parse(llmOutput);
                    let question = (await questionOutputParser.parse(llmOutput)) ?? llmOutput;

                    if (question === "not_needed") {
                         return { query: "", docs: [] };
                    }

                    const folderName = capturedFolderNames[0]; // Or handle multiple folders

                    if (fileLinks.length > 0) {
                         if (question.length === 0) {
                              question = "summarize";
                         }

                         const { documents: snippetDocs } = await getDocumentsFromSnippets(llmOutput, folderName);

                         const docGroups: Document[] = [];

                         for (const doc of snippetDocs) {
                              const filePath = doc.metadata.relativePath;

                              const existingGroup = docGroups.find(
                                   (d) => d.metadata.relativePath === filePath && d.metadata.totalDocs < 10
                              );

                              if (!existingGroup) {
                                   docGroups.push(
                                        new Document({
                                             pageContent: doc.pageContent,
                                             metadata: {
                                                  ...doc.metadata,
                                                  totalDocs: 1,
                                             },
                                        })
                                   );
                              } else {
                                   existingGroup.pageContent += `\n\n` + doc.pageContent;
                                   existingGroup.metadata.totalDocs += 1;
                              }
                         }

                         const docs: Document[] = docGroups;

                         await Promise.all(
                              docGroups.map(async (doc) => {
                                   // Format each document's content with code fences and metadata
                                   const formattedCode = `\`\`\`${doc.metadata.language}
                                   // ${doc.metadata.relativePath}:${doc.metadata.startLine}-${doc.metadata.endLine}
                                   ${doc.pageContent}
                                   \`\`\``;

                                   const res = await llm.invoke(`
                                        You are a code analysis assistant, tasked with explaining code snippets retrieved from a codebase search. Your job is to provide a detailed, 2-4 paragraph explanation that captures the code's purpose, implementation, and relevance to the query.
                                        If the query is "summarize", provide a detailed explanation of what the code does. If the query is a specific question, answer it based on the code.

                                        - **Technical accuracy**: Explain the code's functionality precisely, including key functions, data structures, and patterns used.
                                        - **Implementation details**: Highlight important logic, control flow, dependencies, and any notable design decisions.
                                        - **Context-aware**: Reference the file path and symbol names when relevant.
                                        - **Concise but thorough**: Focus on the most relevant aspects without excessive verbosity.

                                        The query will be inside the \`query\` XML tag. 

                                        <example>
                                        1. Query: "How does authentication work?"

                                        \`\`\`typescript
                                        // src/auth/login.ts:10-25
                                        async function handleLogin(credentials: Credentials): Promise<AuthResult> {
                                             const user = await findUserByEmail(credentials.email);
                                             if (!user) throw new AuthError('User not found');
                                             const valid = await bcrypt.compare(credentials.password, user.passwordHash);
                                             if (!valid) throw new AuthError('Invalid password');
                                             return generateAuthToken(user);
                                        }
                                        \`\`\`

                                        Response:
                                        The authentication flow is handled by the \`handleLogin\` function in \`src/auth/login.ts\`. It takes user credentials and performs a two-step verification: first looking up the user by email, then comparing the provided password against the stored hash using bcrypt.

                                        If either check fails, an \`AuthError\` is thrown with an appropriate message. Upon successful validation, the function generates and returns an authentication token for the user. This implementation follows standard security practices by using bcrypt for password hashing and separating the user lookup from password verification.

                                        2. Query: "summarize"

                                        \`\`\`typescript
                                        // src/utils/retry.ts:5-20
                                        export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, delay = 1000): Promise<T> {
                                             for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                                             try {
                                                  return await fn();
                                             } catch (err) {
                                                  if (attempt === maxAttempts) throw err;
                                                  await sleep(delay * attempt);
                                             }
                                             }
                                             throw new Error('Unreachable');
                                        }
                                        \`\`\`

                                        Response:
                                        The \`withRetry\` utility in \`src/utils/retry.ts\` implements an exponential backoff retry mechanism for async operations. It accepts a function to execute, maximum retry attempts (defaulting to 3), and an initial delay in milliseconds.

                                        The function attempts to execute the provided async function, and on failure, waits for an increasing delay (delay × attempt number) before retrying. If all attempts fail, the last error is propagated. This pattern is useful for handling transient failures in network requests or external service calls.
                                        </example>

                                        Everything below is the actual data you will be working with.

                                        <query>
                                        ${question}
                                        </query>

                                        ${formattedCode}

                                        Make sure to answer the query based on the code provided.
                                   `);

                                   const document = new Document({
                                        pageContent: res.content as string,
                                        metadata: {
                                             type: "code_snippet",
                                             title: doc.metadata.symbolName || doc.metadata.nodeType,
                                             url: `file://${doc.metadata.filePath}`,
                                             relativePath: doc.metadata.relativePath,
                                             language: doc.metadata.language,
                                             startLine: doc.metadata.startLine,
                                             endLine: doc.metadata.endLine,
                                        },
                                   });

                                   docs.push(document);
                              })
                         );

                         return { query: question, docs: docs };
                    } else {
                         question = question.replace(/<think>.*?<\/think>/g, "");

                         // Initialize HNSW search from app config
                         const hnswSearch = HNSWSearch.fromConfig();

                         // Add folders to the index
                         await hnswSearch.addFolders(capturedFolderNames);

                         // Search with threshold filtering
                         // Embed the query using the configured default model
                         const queryEmbedding = await embedQuery(question);
                         const results = await hnswSearch.searchWithThreshold(
                              queryEmbedding,
                              this.config.maxNDocuments
                         );

                         const documents = results.map(
                              (result) =>
                                   new Document({
                                        pageContent: result.content ?? "",
                                        metadata: {
                                             type: "code_snippet",
                                             title:
                                                  (result.metadata.symbolName as string) ||
                                                  (result.metadata.nodeType as string) ||
                                                  result.relativePath,
                                             url: `file://${result.filePath}`,
                                             relativePath: result.relativePath,
                                             folderName: result.folderName,
                                             score: result.score,
                                             language: result.metadata.language,
                                             startLine: result.metadata.startLine,
                                             endLine: result.metadata.endLine,
                                        },
                                   })
                         );

                         return { query: question, docs: documents };
                    }
               }),
          ]);
     }
}

export default CodeSearchAgent;
