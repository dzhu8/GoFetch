"use client";

import { cn } from "@/lib/utils";
import { Popover, PopoverButton, PopoverPanel, Transition } from "@headlessui/react";
import { ChevronDown, Paperclip, FileText, Plus, GraduationCap, LucideIcon } from "lucide-react";
import { Fragment } from "react";
import Attach from "./Attach";
import GetRelatedPapers from "./GetRelatedPapers";
import { useChat } from "@/lib/chat/Chat";

interface OverlayToolItemProps {
  label: string;
  description: string;
  icon: LucideIcon;
  component: React.ReactNode;
}

/** Item that renders an invisible overlay so the real component (e.g. file input) handles the click. */
const OverlayToolItem = ({ label, description, icon: Icon, component }: OverlayToolItemProps) => {
  return (
    <div className="flex flex-row items-start space-x-3 p-3 hover:bg-light-200 dark:hover:bg-dark-200 rounded-lg transition-colors cursor-pointer group relative">
      <div className="mt-1">
        <Icon size={18} className="text-black/50 dark:text-white/50 group-hover:text-sky-500 transition-colors" />
      </div>
      <div className="flex flex-col flex-1">
        <span className="text-sm font-medium text-black dark:text-white">{label}</span>
        <span className="text-xs text-black/50 dark:text-white/50">{description}</span>
      </div>
      <div className="absolute inset-0 opacity-0 overflow-hidden">
        {component}
      </div>
    </div>
  );
};

const ChatToolDropdown = () => {
  const { focusMode, setFocusMode } = useChat();
  const academicActive = focusMode === "academic";

  return (
    <Popover className="relative">
      {({ open, close }) => (
        <>
          <PopoverButton
            className={cn(
              "flex items-center space-x-1 p-2 rounded-lg transition duration-200 focus:outline-none",
              "text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white hover:bg-light-200 dark:hover:bg-dark-200",
              open && "text-black dark:text-white bg-light-200 dark:bg-dark-200"
            )}
          >
            <Plus size={18} />
            <ChevronDown size={14} className={cn("transition-transform duration-200", open && "rotate-180")} />
          </PopoverButton>

          <Transition
            as={Fragment}
            enter="transition ease-out duration-200"
            enterFrom="opacity-0 translate-y-1 scale-95"
            enterTo="opacity-100 translate-y-0 scale-100"
            leave="transition ease-in duration-150"
            leaveFrom="opacity-100 translate-y-0 scale-100"
            leaveTo="opacity-0 translate-y-1 scale-95"
          >
            <PopoverPanel className="absolute left-0 bottom-full mb-2 z-50 w-72 origin-bottom-left">
              <div className="bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-xl shadow-xl overflow-hidden p-1 flex flex-col space-y-1">
                <OverlayToolItem
                  label="Attach Files"
                  description="Upload PDF, DOCX, or TXT for analysis"
                  icon={Paperclip}
                  component={<Attach />}
                />
                <OverlayToolItem
                  label="Related Papers"
                  description="Find academic papers related to your PDF"
                  icon={FileText}
                  component={<GetRelatedPapers />}
                />
                <button
                  type="button"
                  onClick={() => {
                    setFocusMode(academicActive ? "default" : "academic");
                    close();
                  }}
                  className={cn(
                    "flex flex-row items-start space-x-3 p-3 rounded-lg transition-colors w-full text-left group",
                    academicActive
                      ? "bg-sky-500/10 hover:bg-sky-500/20"
                      : "hover:bg-light-200 dark:hover:bg-dark-200"
                  )}
                >
                  <div className="mt-1">
                    <GraduationCap
                      size={18}
                      className={cn(
                        "transition-colors",
                        academicActive ? "text-sky-500" : "text-black/50 dark:text-white/50 group-hover:text-sky-500"
                      )}
                    />
                  </div>
                  <div className="flex flex-col flex-1">
                    <span className={cn("text-sm font-medium", academicActive ? "text-sky-500" : "text-black dark:text-white")}>
                      Academic Search
                      {academicActive && <span className="ml-2 text-xs font-normal opacity-70">(active)</span>}
                    </span>
                    <span className="text-xs text-black/50 dark:text-white/50">
                      {academicActive ? "Click to return to default mode" : "Search arxiv, Google Scholar & PubMed"}
                    </span>
                  </div>
                </button>
              </div>
            </PopoverPanel>
          </Transition>
        </>
      )}
    </Popover>
  );
};

export default ChatToolDropdown;
