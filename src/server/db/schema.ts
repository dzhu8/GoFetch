import { sql } from "drizzle-orm";
import { text, integer, real, sqliteTable, blob, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { Document } from "@langchain/core/documents";

export const messages = sqliteTable("messages", {
     id: integer("id").primaryKey(),
     role: text("type", { enum: ["assistant", "user", "source"] }).notNull(),
     chatId: text("chatId").notNull(),
     createdAt: text("createdAt")
          .notNull()
          .default(sql`CURRENT_TIMESTAMP`),
     messageId: text("messageId").notNull(),

     content: text("content"),

     sources: text("sources", {
          mode: "json",
     })
          .$type<Document[]>()
          .default(sql`'[]'`),
});

interface File {
     name: string;
     fileId: string;
}

export const chats = sqliteTable("chats", {
     id: text("id").primaryKey(),
     title: text("title").notNull(),
     createdAt: text("createdAt").notNull(),
     files: text("files", { mode: "json" })
          .$type<File[]>()
          .default(sql`'[]'`),
});

export const appSettings = sqliteTable("app_settings", {
     key: text("key").primaryKey(),
     value: text("value", { mode: "json" }).$type<unknown | null>(),
     updatedAt: text("updated_at")
          .notNull()
          .default(sql`CURRENT_TIMESTAMP`),
});

export const folders = sqliteTable(
     "folders",
     {
          id: integer("id").primaryKey(),
          name: text("name").notNull(),
          rootPath: text("root_path").notNull(),
          githubUrl: text("github_url"),
          isGitConnected: integer("is_git_connected", { mode: "boolean" }).notNull().default(false),
          createdAt: text("created_at")
               .notNull()
               .default(sql`CURRENT_TIMESTAMP`),
          updatedAt: text("updated_at")
               .notNull()
               .default(sql`CURRENT_TIMESTAMP`),
     },
     (table) => ({
          nameUniqueIdx: uniqueIndex("folders_name_idx").on(table.name),
          rootPathUniqueIdx: uniqueIndex("folders_root_path_idx").on(table.rootPath),
     })
);

type Metadata = Record<string, unknown>;

export const embeddings = sqliteTable("embeddings", {
     id: integer("id").primaryKey(),
     externalId: text("external_id"),
     folderName: text("folder_name").notNull(),
     filePath: text("file_path").notNull(),
     relativePath: text("relative_path").notNull(),
     fileSnapshotId: integer("file_snapshot_id"),
     content: text("content"),
     embedding: blob("embedding").notNull(),
     dim: integer("dim").notNull(),
     metadata: text("metadata", { mode: "json" })
          .$type<Metadata>()
          .default(sql`'{}'`),
     createdAt: text("created_at")
          .default(sql`CURRENT_TIMESTAMP`)
          .notNull(),
});

type MerkleMetadata = Record<string, unknown>;

const MERKLE_NODE_TYPE_ENUM = ["file", "directory"] as const;

export const merkleFolders = sqliteTable(
     "merkle_folders",
     {
          id: integer("id").primaryKey(),
          folderName: text("folder_name").notNull(),
          rootPath: text("root_path").notNull(),
          rootHash: text("root_hash").notNull(),
          metadata: text("metadata", { mode: "json" })
               .$type<MerkleMetadata>()
               .default(sql`'{}'`)
               .notNull(),
          updatedAt: text("updated_at")
               .default(sql`CURRENT_TIMESTAMP`)
               .notNull(),
     },
     (table) => ({
          folderNameUniqueIdx: uniqueIndex("merkle_folders_folder_name_idx").on(table.folderName),
     })
);

export const merkleNodes = sqliteTable(
     "merkle_nodes",
     {
          id: integer("id").primaryKey(),
          folderId: integer("folder_id")
               .notNull()
               .references(() => merkleFolders.id, { onDelete: "cascade" }),
          nodePath: text("node_path").notNull(),
          parentPath: text("parent_path"),
          nodeType: text("node_type", { enum: MERKLE_NODE_TYPE_ENUM })
               .$type<(typeof MERKLE_NODE_TYPE_ENUM)[number]>()
               .notNull(),
          hash: text("hash").notNull(),
          size: integer("size"),
          metadata: text("metadata", { mode: "json" })
               .$type<MerkleMetadata>()
               .default(sql`'{}'`)
               .notNull(),
          updatedAt: text("updated_at")
               .default(sql`CURRENT_TIMESTAMP`)
               .notNull(),
     },
     (table) => ({
          nodePathUniqueIdx: uniqueIndex("merkle_nodes_path_idx").on(table.folderId, table.nodePath),
     })
);

export const monitorEvents = sqliteTable("monitor_events", {
     id: integer("id").primaryKey(),
     folderId: integer("folder_id")
          .notNull()
          .references(() => folders.id, { onDelete: "cascade" }),
     filePath: text("file_path").notNull(),
     needsIndexed: integer("needs_indexed", { mode: "boolean" }).notNull().default(true),
     createdAt: text("created_at")
          .notNull()
          .default(sql`CURRENT_TIMESTAMP`),
     updatedAt: text("updated_at")
          .notNull()
          .default(sql`CURRENT_TIMESTAMP`),
});

// ── Library folders (separate from codebase analytics folders) ────────────────

export const libraryFolders = sqliteTable(
     "library_folders",
     {
          id: integer("id").primaryKey(),
          name: text("name").notNull(),
          rootPath: text("root_path").notNull(),
          createdAt: text("created_at")
               .notNull()
               .default(sql`CURRENT_TIMESTAMP`),
          updatedAt: text("updated_at")
               .notNull()
               .default(sql`CURRENT_TIMESTAMP`),
     },
     (table) => ({
          nameUniqueIdx: uniqueIndex("library_folders_name_idx").on(table.name),
     })
);

export const paperChunks = sqliteTable("paper_chunks", {
     id: integer("id").primaryKey(),
     paperId: integer("paper_id")
          .notNull()
          .references(() => papers.id, { onDelete: "cascade" }),
     sectionType: text("section_type").notNull(), // e.g., "abstract", "figure_title", etc.
     chunkIndex: integer("chunk_index").notNull(),
     content: text("content").notNull(),
     embedding: blob("embedding"),
     createdAt: text("created_at")
          .notNull()
          .default(sql`CURRENT_TIMESTAMP`),
});

// ── Library papers ───────────────────────────────────────────────────────────

const PAPER_STATUS_ENUM = ["uploading", "processing", "ready", "error"] as const;

export const papers = sqliteTable("papers", {
     id: integer("id").primaryKey(),
     folderId: integer("folder_id")
          .notNull()
          .references(() => libraryFolders.id, { onDelete: "cascade" }),
     fileName: text("file_name").notNull(),
     filePath: text("file_path").notNull(),
     title: text("title"),
     doi: text("doi"),
     abstract: text("abstract"),
     semanticScholarId: text("semantic_scholar_id"),
     citation: text("citation"),
     firstFigurePath: text("first_figure_path"),
     status: text("status", { enum: PAPER_STATUS_ENUM })
          .$type<(typeof PAPER_STATUS_ENUM)[number]>()
          .notNull()
          .default("uploading"),
     createdAt: text("created_at")
          .notNull()
          .default(sql`CURRENT_TIMESTAMP`),
     updatedAt: text("updated_at")
          .notNull()
          .default(sql`CURRENT_TIMESTAMP`),
});

// ── Paper ↔ folder many-to-many (secondary / cross-folder links) ─────────────
// The canonical folder is still stored on papers.folderId.  Entries here
// represent additional folders that the same paper should also appear in.
export const paperFolderLinks = sqliteTable(
     "paper_folder_links",
     {
          paperId: integer("paper_id")
               .notNull()
               .references(() => papers.id, { onDelete: "cascade" }),
          folderId: integer("folder_id")
               .notNull()
               .references(() => libraryFolders.id, { onDelete: "cascade" }),
          createdAt: text("created_at")
               .notNull()
               .default(sql`CURRENT_TIMESTAMP`),
     },
     (table) => ({
          pk: primaryKey({ columns: [table.paperId, table.folderId] }),
     })
);

export const relatedPapers = sqliteTable(
     "related_papers",
     {
          id: integer("id").primaryKey(),
          paperId: integer("paper_id")
               .notNull()
               .references(() => papers.id, { onDelete: "cascade" }),
          title: text("title").notNull(),
          authors: text("authors"),
          year: integer("year"),
          venue: text("venue"),
          abstract: text("abstract"),
          doi: text("doi"),
          semanticScholarId: text("semantic_scholar_id"),
          relevanceScore: real("relevance_score"),
          bcScore: real("bc_score"),
          ccScore: real("cc_score"),
          /** Which ranking method produced this row: "bibliographic" | "embedding" */
          rankMethod: text("rank_method").notNull().default("bibliographic"),
          /** The embedding model key used (null for bibliographic method) */
          embeddingModel: text("embedding_model"),
          createdAt: text("created_at")
               .notNull()
               .default(sql`CURRENT_TIMESTAMP`),
     },
     (table) => ({
          // Allows both result sets (bibliographic + embedding) to coexist per source paper
          uniqIdx: uniqueIndex("related_papers_paper_s2_method_idx").on(
               table.paperId,
               table.semanticScholarId,
               table.rankMethod,
          ),
     })
);

const TEXT_FORMAT_ENUM = ["markdown", "text", "json", "yaml", "toml", "xml", "csv", "ini", "log", "env"] as const;

type TextChunkMetadata = Record<string, unknown>;

export const textChunkSnapshots = sqliteTable("text_chunk_snapshots", {
     id: integer("id").primaryKey(),
     folderName: text("folder_name").notNull(),
     filePath: text("file_path").notNull(),
     relativePath: text("relative_path").notNull(),
     format: text("format", { enum: TEXT_FORMAT_ENUM }).$type<(typeof TEXT_FORMAT_ENUM)[number]>().notNull(),
     contentHash: text("content_hash").notNull(),
     chunkIndex: integer("chunk_index").notNull(),
     startIndex: integer("start_index").notNull(),
     endIndex: integer("end_index").notNull(),
     startRow: integer("start_row").notNull(),
     startColumn: integer("start_column").notNull(),
     endRow: integer("end_row").notNull(),
     endColumn: integer("end_column").notNull(),
     content: text("content").notNull(),
     tokenCount: integer("token_count").notNull(),
     truncated: integer("truncated", { mode: "boolean" }).notNull(),
     metadata: text("metadata", { mode: "json" })
          .$type<TextChunkMetadata>()
          .default(sql`'{}'`)
          .notNull(),
     createdAt: text("created_at")
          .default(sql`CURRENT_TIMESTAMP`)
          .notNull(),
});

// --- Academic Search History ---

interface AcademicSource {
     pageContent: string;
     metadata: {
          title: string;
          url: string;
          [key: string]: any;
     };
}

// ── Paper graph cache ────────────────────────────────────────────────────────
// Caches edge data (references + citations) and metadata retrieved from
// Semantic Scholar so subsequent runs avoid redundant API calls.

export const paperEdgeCache = sqliteTable("paper_edge_cache", {
     paperId: text("paper_id").primaryKey(),
     referencesJson: text("references_json"),
     citationsJson: text("citations_json"),
     fetchedAt: integer("fetched_at").notNull(),
});

export const paperMetadataCache = sqliteTable("paper_metadata_cache", {
     paperId: text("paper_id").primaryKey(),
     dataJson: text("data_json").notNull(),
     title: text("title"), // Explicit title field for quick lookup
     abstract: text("abstract"), // Explicit abstract field for embedding cache
     embedding: blob("embedding"), // Legacy single-model embedding (superseded by paperAbstractEmbeddings)
     embeddingModel: text("embedding_model"), // Legacy — tracks which model generated the vector above
     fetchedAt: integer("fetched_at").notNull(),
});

/**
 * Per-paper, per-model abstract embedding cache.
 * Stores one embedding vector per (S2 paper ID, embedding model key) pair so that
 * switching or comparing models never requires re-embedding already-seen papers.
 */
export const paperAbstractEmbeddings = sqliteTable(
     "paper_abstract_embeddings",
     {
          paperId: text("paper_id").notNull(),
          modelKey: text("model_key").notNull(),
          embedding: blob("embedding").notNull(),
          createdAt: integer("created_at").notNull(),
     },
     (table) => ({
          pk: primaryKey({ columns: [table.paperId, table.modelKey] }),
     })
);

export const academicSearches = sqliteTable("academic_searches", {
     id: integer("id").primaryKey(),
     chatId: text("chat_id").notNull(),
     query: text("query").notNull(),
     sources: text("sources", { mode: "json" })
          .$type<AcademicSource[]>()
          .default(sql`'[]'`),
     response: text("response"),
     createdAt: text("created_at")
          .notNull()
          .default(sql`CURRENT_TIMESTAMP`),
});
