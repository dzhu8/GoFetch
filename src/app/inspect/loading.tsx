import { Loader2 } from "lucide-react";

export default function InspectLoading() {
     return (
          <div className="h-full flex flex-col">
               <div className="h-[30vh] flex flex-col items-center justify-center px-6 text-center gap-4">
                    <div>
                         <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                              Codebase Analytics
                         </h1>
                         <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                              Inspect codebase embeddings.
                         </p>
                    </div>
                    <div className="flex flex-col items-center gap-3">
                         <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692]/50 text-black font-medium text-sm">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Loading...
                         </div>
                    </div>
               </div>

               <div className="flex-1 overflow-y-auto px-6 pb-6">
                    <div className="max-w-6xl mx-auto space-y-6">
                         <div className="flex flex-col items-center justify-center py-12">
                              <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                              <p className="text-sm text-black/60 dark:text-white/60">Loading folders...</p>
                         </div>
                    </div>
               </div>
          </div>
     );
}
