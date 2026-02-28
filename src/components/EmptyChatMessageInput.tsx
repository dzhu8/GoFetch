import { ArrowRight, GraduationCap, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import TextareaAutosize from "react-textarea-autosize";
import { useChat } from "@/lib/chat/Chat";
import ModelSelector from "./messageActions/ChatModelSelector";
import ChatToolDropdown from "./messageActions/ChatToolDropdown";
import GoFetchDog from "@/assets/GoFetch-dog-1.svg";

const EmptyChatMessageInput = () => {
     const { sendMessage, focusMode, setFocusMode } = useChat();

     /* const [copilotEnabled, setCopilotEnabled] = useState(false); */
     const [message, setMessage] = useState("");

     const inputRef = useRef<HTMLTextAreaElement | null>(null);

     useEffect(() => {
          const handleKeyDown = (e: KeyboardEvent) => {
               const activeElement = document.activeElement;

               const isInputFocused =
                    activeElement?.tagName === "INPUT" ||
                    activeElement?.tagName === "TEXTAREA" ||
                    activeElement?.hasAttribute("contenteditable");

               if (e.key === "/" && !isInputFocused) {
                    e.preventDefault();
                    inputRef.current?.focus();
               }
          };

          document.addEventListener("keydown", handleKeyDown);

          inputRef.current?.focus();

          return () => {
               document.removeEventListener("keydown", handleKeyDown);
          };
     }, []);

     return (
          <form
               onSubmit={(e) => {
                    e.preventDefault();
                    sendMessage(message);
                    setMessage("");
               }}
               onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                         e.preventDefault();
                         sendMessage(message);
                         setMessage("");
                    }
               }}
               className="w-full"
          >
               <div className="relative">
                    <div className="absolute -top-14 -left-0 pointer-events-none">
                         <Image src={GoFetchDog} alt="GoFetch dog mascot" width={64} height={64} />
                    </div>
                    <div className="flex flex-col bg-light-secondary dark:bg-dark-secondary px-3 pt-5 pb-3 rounded-2xl w-full border border-light-200 dark:border-dark-200 shadow-sm shadow-light-200/10 dark:shadow-black/20 transition-all duration-200 focus-within:border-light-300 dark:focus-within:border-dark-300">
                         <TextareaAutosize
                              ref={inputRef}
                              value={message}
                              onChange={(e) => setMessage(e.target.value)}
                              minRows={2}
                              className="px-2 bg-transparent placeholder:text-[15px] placeholder:text-black/50 dark:placeholder:text-white/50 text-sm text-black dark:text-white resize-none focus:outline-none w-full max-h-24 lg:max-h-36 xl:max-h-48"
                              placeholder={focusMode === "academic" ? "Search for academic papers..." : "Ask anything..."}
                         />
                         <div className="flex flex-row items-center justify-between mt-4">
                              <div className="flex flex-row items-center space-x-2">
                                   <div className="flex flex-row items-center space-x-1">
                                        <ModelSelector />
                                        <ChatToolDropdown />
                                        {focusMode === "academic" && (
                                             <div className="flex items-center space-x-2 px-3 py-1.5 bg-sky-500/10 text-sky-500 rounded-lg text-xs font-medium border border-sky-500/20 whitespace-nowrap min-w-max">
                                                  <div className="flex items-center space-x-1">
                                                       <GraduationCap size={14} />
                                                       <span>Academic Web Search</span>
                                                  </div>
                                                  <button
                                                       type="button"
                                                       onClick={() => setFocusMode("default")}
                                                       className="hover:bg-sky-500/20 rounded-full p-0.5 transition-colors"
                                                  >
                                                       <X size={12} />
                                                  </button>
                                             </div>
                                        )}
                                   </div>
                                   <button
                                        disabled={message.trim().length === 0}
                                        className="bg-sky-500 text-white disabled:text-black/50 dark:disabled:text-white/50 disabled:bg-[#e0e0dc] dark:disabled:bg-[#ececec21] hover:bg-opacity-85 transition duration-100 rounded-full p-2"
                                   >
                                        <ArrowRight className="bg-background" size={17} />
                                   </button>
                              </div>
                         </div>
                    </div>
               </div>
          </form>
     );
};

export default EmptyChatMessageInput;
