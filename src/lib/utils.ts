import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Basename that understands both POSIX and Windows separators. */
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
