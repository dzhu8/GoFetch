import { Loader2 } from "lucide-react";

export default function Loading() {
     return (
          <div className="h-full flex items-center justify-center">
               <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-8 h-8 animate-spin text-[#F8B692]" />
                    <p className="text-sm text-black/60 dark:text-white/60">Loading...</p>
               </div>
          </div>
     );
}
