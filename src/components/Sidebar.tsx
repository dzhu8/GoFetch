"use client";

import GoFetchLogo from "@/assets/GoFetch-logo.svg";
import { cn } from "@/lib/utils";
import { BookCopy, FolderSync, History, Home, MessageSquareMore, Search } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useSelectedLayoutSegments, useRouter } from "next/navigation";
import React, { useState, useEffect, type ReactNode } from "react";
import Layout from "./Layout";
import SettingsButton from "./settings/SettingsButton";

const VerticalIconContainer = ({ children }: { children: ReactNode }) => {
     return <div className="flex flex-col items-center w-full">{children}</div>;
};

const Sidebar = ({ children }: { children: React.ReactNode }) => {
     const segments = useSelectedLayoutSegments();
     const router = useRouter();
     const [isOpen, setIsOpen] = useState<boolean>(true);

     const navLinks = [
          {
               icon: Home,
               href: "/",
               active: segments.length === 0 || segments.includes("c"),
               label: "Home",
          },
          {
               icon: History,
               href: "/chats",
               active: segments.includes("chats"),
               label: "History",
          },
          {
               icon: BookCopy,
               href: "/library",
               active: segments.includes("library"),
               label: "Library",
          },
          {
               icon: FolderSync,
               href: "/sync",
               active: segments.includes("sync"),
               label: "Sync",
          },
          {
               icon: Search,
               href: "/inspect",
               active: segments.includes("inspect"),
               label: "Inspect",
          },
          {
               icon: MessageSquareMore,
               href: "/models",
               active: segments.includes("models"),
               label: "Models",
          },
     ];

     // Prefetch all routes on mount for faster navigation
     useEffect(() => {
          navLinks.forEach((link) => {
               router.prefetch(link.href);
          });
     }, [router]);

     return (
          <div>
               <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-[90px] lg:flex-col border-r border-light-200 dark:border-dark-200">
                    <div className="flex grow flex-col items-center justify-between gap-y-5 overflow-y-auto bg-light-secondary dark:bg-dark-secondary px-2 py-8 shadow-sm shadow-light-200/10 dark:shadow-black/25">
                         <Link
                              href="/"
                              aria-label="Go to home"
                              className="flex flex-col items-center gap-1 hover:opacity-80 transition duration-200"
                         >
                              <Image
                                   src={GoFetchLogo}
                                   alt="GoFetch logo"
                                   width={64}
                                   height={64}
                                   priority
                                   className="h-16 w-16"
                              />
                              <span className="text-[#F8B692] font-['Big_Softie'] text-sm">GoFetch</span>
                         </Link>
                         <VerticalIconContainer>
                              {navLinks.map((link, i) => (
                                   <Link
                                        key={i}
                                        href={link.href}
                                        className={cn(
                                             "relative flex flex-col items-center justify-center space-y-0.5 cursor-pointer w-full py-2 rounded-lg",
                                             link.active
                                                  ? "text-black/70 dark:text-white/70 "
                                                  : "text-black/60 dark:text-white/60"
                                        )}
                                   >
                                        <div
                                             className={cn(
                                                  link.active && "bg-light-200 dark:bg-dark-200",
                                                  "group rounded-lg hover:bg-light-200 hover:dark:bg-dark-200 transition duration-200"
                                             )}
                                        >
                                             <link.icon
                                                  size={25}
                                                  className={cn(
                                                       !link.active && "group-hover:scale-105",
                                                       "transition duration:200 m-1.5"
                                                  )}
                                             />
                                        </div>
                                        <p
                                             className={cn(
                                                  link.active
                                                       ? "text-black/80 dark:text-white/80"
                                                       : "text-black/60 dark:text-white/60",
                                                  "text-[10px]"
                                             )}
                                        >
                                             {link.label}
                                        </p>
                                   </Link>
                              ))}
                         </VerticalIconContainer>

                         <SettingsButton />
                    </div>
               </div>

               <div className="fixed bottom-0 w-full z-50 flex flex-row items-center gap-x-6 bg-light-secondary dark:bg-dark-secondary px-4 py-4 shadow-sm lg:hidden">
                    {navLinks.map((link, i) => (
                         <Link
                              href={link.href}
                              key={i}
                              className={cn(
                                   "relative flex flex-col items-center space-y-1 text-center w-full",
                                   link.active ? "text-black dark:text-white" : "text-black dark:text-white/70"
                              )}
                         >
                              {link.active && (
                                   <div className="absolute top-0 -mt-4 h-1 w-full rounded-b-lg bg-black dark:bg-white" />
                              )}
                              <link.icon />
                              <p className="text-xs">{link.label}</p>
                         </Link>
                    ))}
               </div>

               <Layout>{children}</Layout>
          </div>
     );
};

export default Sidebar;
