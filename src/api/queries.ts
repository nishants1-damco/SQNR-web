// TanStack Query hooks over the API. Query keys keep the names the original
// app used ("spaces", "space", "space-export"), so invalidation calls in the
// components keep working.
import type { ScanListQuery } from "@spatial/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useAuth } from "./auth";
import { spaces } from "./spaces";

/** The catalog, a page at a time; filters and sorting run on the server. */
export function useSpaceList(filters: Pick<ScanListQuery, "sort"> & Partial<ScanListQuery>) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ["spaces", user?.id, filters],
    enabled: !!user,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      spaces.list({ ...filters, limit: 30, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Thumbnail URLs live an hour; refresh the list at half-life.
    staleTime: 30 * 60 * 1000,
    // While anything is mid-reconstruction, refresh so it flips to "ready" on its own.
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.items.some((s) => s.status === "processing"))
        ? 10_000
        : false,
  });
}

export function useSpace(id: string) {
  return useQuery({
    queryKey: ["space", id],
    queryFn: ({ signal }) => spaces.get(id, signal),
    // Frame URLs live an hour.
    staleTime: 30 * 60 * 1000,
    refetchInterval: (query) => {
      const notes = (query.state.data?.scan.analysis_notes ?? {}) as {
        privacy_sweep?: { status?: string };
      };
      // A queued privacy sweep has no event stream: poll until it's done.
      return notes.privacy_sweep?.status === "queued" ? 4000 : false;
    },
  });
}

export function useSpaceExport(id: string) {
  return useQuery({
    queryKey: ["space-export", id],
    queryFn: () => spaces.export(id),
    staleTime: 30_000,
  });
}

/** The caller's feature flags, once per session (plan §13.2). */
export function useFlags() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["flags", user?.id],
    enabled: !!user,
    queryFn: async () => (await spaces.flags()).flags,
    staleTime: 60_000,
  });
}
