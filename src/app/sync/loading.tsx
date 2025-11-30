import { Loader2 } from "lucide-react";

export default function SyncLoading() {
     return (
          <div className="h-full flex flex-col">
               {/* Header Section - 30% of screen */}
               <div className="h-[30vh] flex items-center justify-center px-6">
                    <div className="text-center">
                         <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                              Sync from Github
                         </h1>
                         <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                              Manage and sync your GitHub repositories
                         </p>
                         <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692]/50 text-black font-medium text-sm">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Loading...
                         </div>
                    </div>
               </div>

               {/* Cards Section - skeleton */}
               <div className="flex-1 overflow-y-auto px-6 pb-6">
                    <div className="flex flex-col items-center justify-center py-12">
                         <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                         <p className="text-sm text-black/60 dark:text-white/60">Loading folders...</p>
                    </div>
               </div>
          </div>
     );
}
