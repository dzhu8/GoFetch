/**
 * Webpack global declarations for native module handling.
 * These globals are available in webpack/Turbopack bundled code.
 */

/**
 * Webpack's internal require function.
 * Available when code is bundled by webpack/Turbopack.
 */
declare const __webpack_require__: ((id: string) => any) | undefined;

/**
 * Non-webpack require that bypasses bundling.
 * Allows loading native Node.js modules directly without webpack processing.
 */
declare const __non_webpack_require__: NodeRequire;
