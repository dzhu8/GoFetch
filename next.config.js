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
     },
     // Enable React strict mode for better development experience
     reactStrictMode: true,
};

module.exports = nextConfig;
