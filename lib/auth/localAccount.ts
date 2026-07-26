import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { env, isProductionLike, type RuntimeEnv } from "@/lib/config/env";

export function safeAuthRedirect(value: FormDataEntryValue | string | null | undefined, fallback = "/dashboard") {
  const raw = typeof value === "string" ? value : "";
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}

export function displayNameFromEmail(value: string | null | undefined) {
  const localPart = value?.includes("@") ? value.split("@")[0] : "";
  return localPart?.replace(/[._-]+/g, " ").trim().slice(0, 40) || "Preview user";
}

export function previewUserIdFromEmail(value: string) {
  return `preview-${crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}

export function setLocalAccountCookies(response: NextResponse, account: { email: string; name?: string; role?: "user" | "moderator" }, runtime: RuntimeEnv = env) {
  const secure = isProductionLike(runtime);
  const email = account.email.trim().toLowerCase();
  const name = account.name?.trim().slice(0, 80) || displayNameFromEmail(email);
  response.cookies.set("cmai_user_id", previewUserIdFromEmail(email), { httpOnly: true, sameSite: "lax", secure, path: "/" });
  response.cookies.set("cmai_user_name", name, { httpOnly: true, sameSite: "lax", secure, path: "/" });
  response.cookies.set("cmai_role", account.role || "user", { httpOnly: true, sameSite: "lax", secure, path: "/" });
  response.cookies.set("cmai_csrf", crypto.randomBytes(24).toString("hex"), { sameSite: "lax", secure, path: "/" });
  return response;
}
