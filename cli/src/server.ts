import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { selectFolderInteractive, deriveFolderName } from "./folderPicker";
import { findFolderByPath } from "./db";

type FolderSelectionEvent = {
     path: string;
     name?: string;
     timestamp: number;
     version: number;
};

const DEFAULT_PORT = 4820;
const port = Number(process.env.GOFETCH_CLI_PORT ?? DEFAULT_PORT);

let latestSelection: FolderSelectionEvent | null = null;
let selectionVersion = 0;

const ALLOWED_METHODS = "GET,POST,OPTIONS";
const ALLOWED_HEADERS = "Content-Type";

const setCorsHeaders = (res: ServerResponse) => {
     res.setHeader("Access-Control-Allow-Origin", "*");
     res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
     res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
};

const sendJson = (res: ServerResponse, statusCode: number, payload: Record<string, unknown>) => {
     res.statusCode = statusCode;
     res.setHeader("Content-Type", "application/json");
     res.end(JSON.stringify(payload));
};

const normalizeFolderPath = (folderPath: string): string => {
     try {
          return path.resolve(folderPath);
     } catch {
          return folderPath;
     }
};

const resolveSelectionName = (folderPath: string, providedName?: string) => {
     const trimmed = providedName?.trim();
     if (trimmed) {
          return trimmed;
     }

     const stored = findFolderByPath(folderPath);
     if (stored?.name) {
          return stored.name;
     }

     return deriveFolderName(folderPath);
};

const readJsonBody = async <T = Record<string, unknown>>(req: IncomingMessage): Promise<T> => {
     return await new Promise<T>((resolve, reject) => {
          let body = "";
          req.on("data", (chunk) => {
               body += chunk;
          });
          req.on("end", () => {
               try {
                    const parsed = body.length ? JSON.parse(body) : {};
                    resolve(parsed as T);
               } catch (error) {
                    reject(error);
               }
          });
          req.on("error", (error) => reject(error));
     });
};

const server = createServer(async (req, res) => {
     setCorsHeaders(res);

     if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
     }

     if (!req.url) {
          sendJson(res, 400, { error: "Invalid request" });
          return;
     }

     const url = new URL(req.url, `http://localhost:${port}`);
     const pathname = url.pathname;

     if (req.method === "GET" && pathname === "/health") {
          sendJson(res, 200, { status: "ok" });
          return;
     }

     if (req.method === "GET" && pathname === "/selection/latest") {
          sendJson(res, 200, {
               version: latestSelection?.version ?? selectionVersion,
               selection: latestSelection,
          });
          return;
     }

     if (req.method === "POST" && pathname === "/selection/prompt") {
          try {
               const selection = await selectFolderInteractive();

               if (!selection) {
                    sendJson(res, 200, { status: "cancelled" });
                    return;
               }

               const normalizedPath = normalizeFolderPath(selection.path);
               const resolvedName = resolveSelectionName(normalizedPath, selection.name);
               selectionVersion += 1;
               latestSelection = {
                    path: normalizedPath,
                    name: resolvedName,
                    timestamp: Date.now(),
                    version: selectionVersion,
               };

               sendJson(res, 200, { status: "recorded", selection: latestSelection });
          } catch (error) {
               console.error("Folder picker failed:", error);
               sendJson(res, 500, {
                    error: error instanceof Error ? error.message : "Unable to open the folder picker on this system.",
               });
          }
          return;
     }

     if (req.method === "POST" && pathname === "/selection") {
          try {
               const body = await readJsonBody<{ path?: string; name?: string }>(req);
               if (!body.path || typeof body.path !== "string") {
                    sendJson(res, 400, { error: "'path' is required" });
                    return;
               }

               const normalizedPath = normalizeFolderPath(body.path);
               const resolvedName = resolveSelectionName(normalizedPath, body.name);
               selectionVersion += 1;
               latestSelection = {
                    path: normalizedPath,
                    name: resolvedName,
                    timestamp: Date.now(),
                    version: selectionVersion,
               };

               sendJson(res, 201, { status: "recorded", version: selectionVersion });
          } catch (error) {
               console.error("Failed to record folder selection:", error);
               sendJson(res, 400, { error: "Invalid JSON body" });
          }
          return;
     }

     sendJson(res, 404, { error: "Not implemented" });
});

server.listen(port, () => {
     console.log(`GoFetch CLI helper listening on http://localhost:${port}`);
     console.log("Press Ctrl+C to stop the CLI helper.");
});

const shutdown = () => {
     console.log("Shutting down GoFetch CLI helper...");
     server.close(() => {
          process.exit(0);
     });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
