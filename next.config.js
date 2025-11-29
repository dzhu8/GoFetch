/** @type {import('next').NextConfig} */
const nextConfig = {
     // Suppress fetch logging in development to reduce terminal noise
     // from frequent polling requests (e.g., /api/folders every 3s)
     logging: {
          fetches: {
               fullUrl: false,
          },
     },
     // Suppress compilation/request logs in dev (requires Next.js 14.1+)
     ...(process.env.NEXT_QUIET === "true" && {
          onDemandEntries: {
               maxInactiveAge: 60 * 1000,
               pagesBufferLength: 5,
          },
     }),
};

module.exports = nextConfig;
