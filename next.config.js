/** @type {import('next').NextConfig} */
const nextConfig = {
     // Suppress fetch logging in development to reduce terminal noise
     // from frequent polling requests (e.g., /api/folders every 3s)
     logging: {
          fetches: {
               fullUrl: false,
          },
     },
     // Optimize development experience: keep compiled pages in memory longer
     // This significantly reduces recompilation lag when navigating between routes
     onDemandEntries: {
          // Keep pages in memory for 5 minutes (default is 15 seconds)
          maxInactiveAge: 5 * 60 * 1000,
          // Keep more pages buffered in memory (default is 2)
          pagesBufferLength: 10,
     },
     // Enable experimental features for faster development
     experimental: {
          // Optimize package imports for faster compilation
          optimizePackageImports: ["lucide-react", "@headlessui/react", "framer-motion"],
          // Native Node.js modules that should not be bundled
          serverExternalPackages: ["faiss-node", "better-sqlite3"],
     },
     // Turbopack configuration for development (Next.js 16+ uses Turbopack by default)
     turbopack: {
          // Resolve aliases if needed
          resolveAlias: {},
     },
     // Configure webpack for native modules (used in production builds)
     webpack: (config, { isServer }) => {
          if (isServer) {
               // Prevent webpack from bundling native modules
               config.externals = config.externals || [];
               config.externals.push({
                    "faiss-node": "commonjs faiss-node",
                    "better-sqlite3": "commonjs better-sqlite3",
               });
          }
          return config;
     },
     // Enable React strict mode for better development experience
     reactStrictMode: true,
};

module.exports = nextConfig;
