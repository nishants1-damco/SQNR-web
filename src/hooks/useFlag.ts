// One feature flag for the signed-in user (user override, then global
// default, then `defaultValue`). All flags come in one request per session,
// cached by Query; the original read `feature_flags` from Supabase per key.
import { useFlags } from "@/api/queries";

export function useFlag(key: string, defaultValue = false): boolean {
  const { data } = useFlags();
  return data?.[key] ?? defaultValue;
}
