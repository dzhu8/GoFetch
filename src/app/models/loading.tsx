import { Loader2 } from "lucide-react";

export default function ModelsLoading() {
     return (
          <div className="h-full flex flex-col">
               <div className="h-[30vh] flex flex-col items-center justify-center px-6 text-center gap-4">
                    <div>
                         <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                              Models & Providers
                         </h1>
                         <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                              Discover & download available models across every connected provider.
                         </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-black/70 dark:text-white/70">
                         <div className="px-4 py-2 rounded-xl border-2 border-light-200 dark:border-dark-200 bg-light-primary/70 dark:bg-dark-primary/70 animate-pulse">
                              — Providers
                         </div>
                         <div className="px-4 py-2 rounded-xl border-2 border-light-200 dark:border-dark-200 bg-light-primary/70 dark:bg-dark-primary/70 animate-pulse">
                              — Models
                         </div>
                    </div>
               </div>

               <div className="flex-1 overflow-y-auto px-6 pb-6">
                    <div className="flex flex-col items-center justify-center py-12">
                         <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                         <p className="text-sm text-black/60 dark:text-white/60">Loading providers...</p>
                    </div>
               </div>
          </div>
     );
}
