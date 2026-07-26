
"use client";

export function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const token = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("cmai_csrf="))?.slice("cmai_csrf=".length);
  return token ? { "x-cmai-csrf": decodeURIComponent(token) } : {};
}
