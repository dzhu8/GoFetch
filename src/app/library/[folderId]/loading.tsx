export default function FolderLoading() {
     return (
          <div className="flex flex-col items-center justify-center h-full py-12">
               <div className="w-8 h-8 border-2 border-[#F8B692] border-t-transparent rounded-full animate-spin" />
               <p className="text-sm text-black/60 dark:text-white/60 mt-3">Loading papers...</p>
          </div>
     );
}
