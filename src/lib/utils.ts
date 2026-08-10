import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateClientId(prefix = "id") {
  const cryptoRef = globalThis.crypto as Crypto & { randomUUID?: () => string };
  const generated = cryptoRef.randomUUID?.() ?? `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  return generated;
}
