import { sql } from "drizzle-orm";
import { text, integer, sqliteTable, blob, uniqueIndex } from "drizzle-orm/sqlite-core";
import { Document } from "@langchain/core/documents";
import type { ASTParseDiagnostics, SerializedNode, SupportedLanguage } from "@/lib/ast/types";

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

type Metadata = Record<string, unknown>;

export const embeddings = sqliteTable("embeddings", {
     id: integer("id").primaryKey(),
     externalId: text("external_id"),
     folderName: text("folder_name").notNull(),
     filePath: text("file_path").notNull(),
     relativePath: text("relative_path").notNull(),
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

type ASTMetadata = Record<string, unknown>;

const AST_LANGUAGE_ENUM = ["javascript", "typescript", "tsx", "python", "rust", "css", "html"] as const satisfies SupportedLanguage[];

export const astFileSnapshots = sqliteTable("ast_file_snapshots", {
     id: integer("id").primaryKey(),
     folderName: text("folder_name").notNull(),
     filePath: text("file_path").notNull(),
     relativePath: text("relative_path").notNull(),
     language: text("language", { enum: AST_LANGUAGE_ENUM })
          .$type<SupportedLanguage>()
          .notNull(),
     contentHash: text("content_hash").notNull(),
     ast: text("ast", { mode: "json" })
          .$type<SerializedNode>()
          .notNull(),
     diagnostics: text("diagnostics", { mode: "json" })
          .$type<ASTParseDiagnostics>()
          .default(sql`'{}'`)
          .notNull(),
     metadata: text("metadata", { mode: "json" })
          .$type<ASTMetadata>()
          .default(sql`'{}'`)
          .notNull(),
     parsedAt: text("parsed_at")
          .default(sql`CURRENT_TIMESTAMP`)
          .notNull(),
});

export const astNodes = sqliteTable("ast_nodes", {
     id: integer("id").primaryKey(),
     fileId: integer("file_id")
          .notNull()
          .references(() => astFileSnapshots.id, { onDelete: "cascade" }),
     nodePath: text("node_path").notNull(),
     type: text("type").notNull(),
     named: integer("named", { mode: "boolean" }).notNull(),
     hasError: integer("has_error", { mode: "boolean" }).notNull(),
     startIndex: integer("start_index").notNull(),
     endIndex: integer("end_index").notNull(),
     startRow: integer("start_row").notNull(),
     startColumn: integer("start_column").notNull(),
     endRow: integer("end_row").notNull(),
     endColumn: integer("end_column").notNull(),
     childCount: integer("child_count").notNull(),
     textSnippet: text("text_snippet"),
     metadata: text("metadata", { mode: "json" })
          .$type<ASTMetadata>()
          .default(sql`'{}'`)
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
          lastCheckedAt: text("last_checked_at")
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


