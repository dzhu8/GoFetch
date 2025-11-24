export {};

declare global {
     interface Window {
          GoFetchCLI?: {
               /** Opens a native folder selector and resolves with the chosen path */
               selectFolder?: () => Promise<{ path: string; name?: string } | null>;
               /** Requests the native helper to start watching folder selections */
               requestWatcherConsent?: () => Promise<boolean>;
          };
     }
}
