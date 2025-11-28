import type { FolderRegistrationLike, ParserOptions, ParsedFileAst } from "./types";
import { listSupportedFiles } from "./fileWalker";
import { parseFiles } from "./parser";

export function parseFolderRegistration(
     registration: FolderRegistrationLike,
     options?: ParserOptions
): ParsedFileAst[] {
     const files = listSupportedFiles(registration);
     return parseFiles(files, options);
}

export * from "./types";
export * from "./languages";
export * from "./focusNodes";
export * from "./focusLabels";
export { parseFiles, parseFile } from "./parser";
