import { HttpError } from "@/lib/api/responses";

export function requireSupabaseStore() {
  throw new HttpError(501, "Supabase/Postgres store adapter is not implemented in this MVP build. Use local JSON mode or wire DATABASE_URL before production deploy.", "store_not_implemented");
}
