// Use ISR with a short revalidation period instead of force-dynamic
// This allows pages to be cached and served quickly while still updating
export const revalidate = 60; // Revalidate every 60 seconds

import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";
import Sidebar from "@/components/Sidebar";
import configManager from "@/server";
import { Toaster } from "sonner";
import ThemeProvider from "@/components/theme/Provider";
import { ChatProvider } from "@/lib/chat/Chat";
import SetupWizard from "@/components/setup/SetupWizard";
import PaddleInstallMonitor from "@/components/setup/PaddleInstallMonitor";
import { TaskProgressProvider } from "@/components/progress/TaskProgressProvider";
import TaskProgressToasts from "@/components/progress/TaskProgressToasts";
import { PdfParseProvider } from "@/components/progress/PdfParseProvider";
import PdfParseToasts from "@/components/progress/PdfParseToasts";

const montserrat = Montserrat({
     weight: ["300", "400", "500", "700"],
     subsets: ["latin"],
     display: "swap",
     fallback: ["Arial", "sans-serif"],
});

export const metadata: Metadata = {
     title: "GoFetch - Live index of your research papers",
     description: "GoFetch performs research paper indexing using local language models.",
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
                         <TaskProgressProvider>
                              <PdfParseProvider>
                              {setupComplete ? (
                                   <ChatProvider>
                                        <Sidebar>{children}</Sidebar>
                                        <PaddleInstallMonitor />
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
                              <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3 w-full max-w-sm pointer-events-none">
                                   <PdfParseToasts />
                                   <TaskProgressToasts />
                              </div>
                              </PdfParseProvider>
                         </TaskProgressProvider>
                    </ThemeProvider>
               </body>
          </html>
     );
}
