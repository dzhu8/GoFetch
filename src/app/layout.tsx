export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import Sidebar from "@/components/Sidebar";
import configManager from "@/server";
import { Toaster } from "sonner";
import ThemeProvider from "@/components/theme/Provider";
import { ChatProvider } from "@/lib/chat/Chat";
import SetupWizard from "@/components/setup/SetupWizard";
import { EmbeddingProgressProvider } from "@/components/embed/EmbeddingProgressProvider";
import EmbeddingProgressToasts from "@/components/embed/EmbeddingProgressToasts";

const montserrat = Montserrat({
     weight: ["300", "400", "500", "700"],
     subsets: ["latin"],
     display: "swap",
     fallback: ["Arial", "sans-serif"],
});

export const metadata: Metadata = {
     title: "GoFetch - Live index of your codebase",
     description: "GoFetch performs codebase indexing using local language models.",
};

export default async function RootLayout({
     children,
}: Readonly<{
     children: React.ReactNode;
}>) {
     const setupComplete = configManager.isSetupComplete();
     const configSections = configManager.getUIConfigSections();

     return (
          <html className={cn("h-full", montserrat.className)} lang="en" suppressHydrationWarning>
               <body className="h-full">
                    <ThemeProvider>
                         <EmbeddingProgressProvider>
                              {setupComplete ? (
                                   <ChatProvider>
                                        <Sidebar>{children}</Sidebar>
                                        <Toaster
                                             toastOptions={{
                                                  unstyled: true,
                                                  classNames: {
                                                       toast: "bg-light-secondary dark:bg-dark-secondary dark:text-white/70 text-black-70 rounded-lg p-4 flex flex-row items-center space-x-2",
                                                  },
                                             }}
                                        />
                                   </ChatProvider>
                              ) : (
                                   <SetupWizard configSections={configSections} />
                              )}
                              <EmbeddingProgressToasts />
                         </EmbeddingProgressProvider>
                    </ThemeProvider>
               </body>
          </html>
     );
}
