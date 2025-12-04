"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Loader2, Trash2 } from "lucide-react";
import GoFetchDogSweater from "@/assets/GoFetch-dog-sweater.svg";

type ChatData = {
     id: string;
     title: string;
     createdAt: string;
};

const formatDate = (dateString: string) => {
     const date = new Date(dateString);
     return date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
     });
};

export default function ChatsPage() {
     const router = useRouter();
     const [chats, setChats] = useState<ChatData[]>([]);
     const [isLoading, setIsLoading] = useState(true);
     const [deletingId, setDeletingId] = useState<string | null>(null);
     const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

     const fetchChats = async () => {
          try {
               setIsLoading(true);
               const res = await fetch("/api/chats");
               if (!res.ok) throw new Error("Failed to fetch chats");

               const data = await res.json();
               setChats(data.chats || []);
          } catch (error) {
               console.error("Error fetching chats:", error);
          } finally {
               setIsLoading(false);
          }
     };

     const handleDelete = async (chatId: string) => {
          setDeletingId(chatId);
          try {
               const res = await fetch(`/api/chats/${chatId}`, {
                    method: "DELETE",
               });

               if (!res.ok) throw new Error("Failed to delete chat");

               setChats((prev) => prev.filter((chat) => chat.id !== chatId));
          } catch (error) {
               console.error("Error deleting chat:", error);
          } finally {
               setDeletingId(null);
               setConfirmDeleteId(null);
          }
     };

     useEffect(() => {
          fetchChats();
     }, []);

     return (
          <div className="h-full flex flex-col">
               {/* Header Section */}
               <div className="h-[30vh] flex items-center justify-center px-6">
                    <div className="flex items-center gap-4">
                         <Image
                              src={GoFetchDogSweater}
                              alt="GoFetch dog with sweater"
                              width={80}
                              height={80}
                              className="w-16 h-16 md:w-20 md:h-20"
                         />
                         <div className="text-center">
                              <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                                   Chat History
                              </h1>
                              <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                                   View and manage your previous conversations
                              </p>
                         </div>
                    </div>
               </div>

               {/* Chats List Section */}
               <div className="flex-1 overflow-y-auto px-6 pb-6">
                    {isLoading ? (
                         <div className="flex flex-col items-center justify-center py-12">
                              <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                              <p className="text-sm text-black/60 dark:text-white/60">Loading chats...</p>
                         </div>
                    ) : chats.length === 0 ? (
                         <div className="flex flex-col items-center justify-center py-12 text-center">
                              <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                   No chat history found
                              </p>
                              <p className="text-sm text-black/50 dark:text-white/50">
                                   Start a conversation to see it here
                              </p>
                         </div>
                    ) : (
                         <div className="flex flex-col gap-3 max-w-4xl mx-auto w-full">
                              {chats.map((chat) => (
                                   <div
                                        key={chat.id}
                                        onClick={() => router.push(`/c/${chat.id}`)}
                                        className="relative bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow duration-200 cursor-pointer w-full"
                                   >
                                        <div className="flex items-start justify-between gap-3">
                                             <div className="flex-1 min-w-0">
                                                  <h3 className="text-sm font-medium text-black dark:text-white truncate">
                                                       {chat.title}
                                                  </h3>
                                                  <p className="text-xs text-black/50 dark:text-white/50 mt-1">
                                                       {formatDate(chat.createdAt)}
                                                  </p>
                                             </div>
                                             <button
                                                  type="button"
                                                  onClick={(e) => {
                                                       e.stopPropagation();
                                                       setConfirmDeleteId(chat.id);
                                                  }}
                                                  disabled={deletingId === chat.id}
                                                  className="p-2 rounded-lg text-black/50 dark:text-white/50 hover:text-red-500 hover:bg-red-500/10 transition-colors duration-200 disabled:opacity-50"
                                                  aria-label="Delete chat"
                                             >
                                                  {deletingId === chat.id ? (
                                                       <Loader2 className="w-4 h-4 animate-spin" />
                                                  ) : (
                                                       <Trash2 className="w-4 h-4" />
                                                  )}
                                             </button>
                                        </div>
                                   </div>
                              ))}
                         </div>
                    )}
               </div>

               {/* Confirmation Modal */}
               {confirmDeleteId && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg text-center">
                              <Trash2 className="w-10 h-10 text-red-500 mx-auto mb-3" />
                              <h2 className="text-lg font-semibold text-black dark:text-white mb-2">Delete Chat?</h2>
                              <p className="text-sm text-black/60 dark:text-white/60 mb-6">
                                   This action cannot be undone. The chat and all its messages will be permanently
                                   removed.
                              </p>
                              <div className="flex justify-center gap-3">
                                   <button
                                        type="button"
                                        onClick={() => setConfirmDeleteId(null)}
                                        className="px-4 py-2 rounded-lg border border-light-200 dark:border-dark-200 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                   >
                                        Cancel
                                   </button>
                                   <button
                                        type="button"
                                        onClick={() => handleDelete(confirmDeleteId)}
                                        disabled={deletingId !== null}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 active:scale-95 transition-all duration-200 disabled:opacity-50"
                                   >
                                        {deletingId ? (
                                             <>
                                                  <Loader2 className="w-4 h-4 animate-spin" />
                                                  Deleting...
                                             </>
                                        ) : (
                                             "Delete"
                                        )}
                                   </button>
                              </div>
                         </div>
                    </div>
               )}
          </div>
     );
}
