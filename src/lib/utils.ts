import clsx, { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...classes: ClassValue[]) => twMerge(clsx(...classes));

export const formatTimeDifference = (date1: Date | string, date2: Date | string): string => {
     date1 = new Date(date1);
     date2 = new Date(date2);

     const diffInSeconds = Math.floor(Math.abs(date2.getTime() - date1.getTime()) / 1000);

     if (diffInSeconds < 60) return `${diffInSeconds} second${diffInSeconds !== 1 ? "s" : ""}`;
     else if (diffInSeconds < 3600)
          return `${Math.floor(diffInSeconds / 60)} minute${Math.floor(diffInSeconds / 60) !== 1 ? "s" : ""}`;
     else if (diffInSeconds < 86400)
          return `${Math.floor(diffInSeconds / 3600)} hour${Math.floor(diffInSeconds / 3600) !== 1 ? "s" : ""}`;
     else if (diffInSeconds < 31536000)
          return `${Math.floor(diffInSeconds / 86400)} day${Math.floor(diffInSeconds / 86400) !== 1 ? "s" : ""}`;
     else return `${Math.floor(diffInSeconds / 31536000)} year${Math.floor(diffInSeconds / 31536000) !== 1 ? "s" : ""}`;
};

/**
 * Sends a system (OS/Browser) notification if permission is granted.
 * Requests permission if not already granted.
 */
export const sendSystemNotification = async (title: string, options?: NotificationOptions) => {
     if (typeof window === "undefined" || !("Notification" in window)) return;

     if (Notification.permission === "granted") {
          new Notification(title, options);
     } else if (Notification.permission !== "denied") {
          const permission = await Notification.requestPermission();
          if (permission === "granted") {
               new Notification(title, options);
          }
     }
};

export const cosineSimilarity = (vectorA: number[], vectorB: number[]): number => {
     if (!Array.isArray(vectorA) || !Array.isArray(vectorB)) {
          throw new Error("Cosine similarity requires two numeric vectors");
     }

     if (vectorA.length === 0 || vectorB.length === 0 || vectorA.length !== vectorB.length) {
          throw new Error("Vectors must be non-empty and equal in length");
     }

     let dot = 0;
     let magA = 0;
     let magB = 0;

     for (let i = 0; i < vectorA.length; i += 1) {
          const a = vectorA[i] ?? 0;
          const b = vectorB[i] ?? 0;
          dot += a * b;
          magA += a * a;
          magB += b * b;
     }

     if (magA === 0 || magB === 0) {
          throw new Error("Cannot compute cosine similarity for zero-magnitude vectors");
     }

     return dot / (Math.sqrt(magA) * Math.sqrt(magB));
};
