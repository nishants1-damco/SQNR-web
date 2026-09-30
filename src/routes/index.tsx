import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { useSpaceList } from "@/api/queries";
import { APP_VERSION } from "@/lib/version";
import { useAuth } from "@/lib/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Plus,
  LogOut,
  Waves,
  Ruler,
  DoorOpen,
  Boxes,
  Search,
  Download,
  Trash2,
} from "lucide-react";
import { DeleteSpaceDialog } from "@/components/DeleteSpaceDialog";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/lib/theme";
import { usePwaInstall } from "@/lib/pwa-install";

/**
 * `?reconstructing=<scanId>`: the capture page handed off a reconstruction
 * that outlasted its wait, so tell the user it's still running.
 */
interface CatalogSearch {
  reconstructing?: string;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): CatalogSearch =>
    typeof search["reconstructing"] === "string"
      ? { reconstructing: search["reconstructing"] }
      : {},
  head: () => ({
    meta: [
      { title: "SQNR · scan rooms, browse the catalog" },
      {
        name: "description",
        content:
          "Capture a room with your phone camera and a sonic ping, then browse 2D plans, 3D walkthroughs, object tags, portals and acoustic data for every space you've scanned.",
      },
      { property: "og:title", content: "SQNR · scan rooms, browse the catalog" },
      {
        property: "og:description",
        content:
          "Phone-based reality capture: photos, compass headings and room acoustics turned into navigable 2D and 3D models.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Catalog,
});

function Catalog() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { reconstructing } = Route.useSearch();
  const [signingOut, setSigningOut] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "processing" | "failed">(
    "all",
  );
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "name" | "area">("newest");
  const { installable, install } = usePwaInstall();

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  // Stalled analyses are failed by the server's maintenance sweep now (it was
  // a fire-and-forget call from this page).

  // Search, filter and sort run on the server, a page at a time. The search
  // box waits for a pause in typing before it queries.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const list = useSpaceList({
    sort: sortBy,
    ...(term ? { q: term } : {}),
    ...(statusFilter === "all" ? {} : { status: statusFilter }),
  });
  const { isLoading } = list;
  const filteredSpaces = useMemo(
    () => (list.data?.pages ?? []).flatMap((page) => page.items),
    [list.data],
  );
  const totals = list.data?.pages[0]?.totals;
  const [reconstructingSpace, setReconstructingSpace] = useState<string | null>(null);
  useEffect(() => {
    if (!reconstructing || !user) return;
    // The name may be on a page that isn't loaded; ask for the space itself.
    void api
      .request<{ scan: { name: string } }>("GET", `/v1/scans/${reconstructing}`)
      .then((r) => setReconstructingSpace(r.scan.name))
      .catch(() => setReconstructingSpace(null));
  }, [reconstructing, user]);

  const totalCount = totals?.count ?? 0;
  const totalArea = totals?.floorAreaM2 ?? 0;
  const loadedObjects = filteredSpaces.reduce((s, x) => s + x.object_count, 0);
  const reconstructingName = reconstructingSpace;
  // Replace, so a reload or back doesn't re-open the notice.
  const dismissReconstructing = () => navigate({ to: "/", search: {}, replace: true });

  return (
    <main className="min-h-screen bg-background pb-24">
      <header className="brand-bar safe-top sticky top-0 z-20 border-b">
        <div className="mx-auto flex min-h-[52px] w-full max-w-5xl items-center justify-between px-4 pb-3 pt-2 sm:px-6">
          <BrandMark />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  aria-label="Sign out"
                  className="press inline-flex size-10 items-center justify-center rounded-full bg-secondary text-foreground/70"
                >
                  <LogOut className="size-[18px]" />
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Sign out?</AlertDialogTitle>
                  <AlertDialogDescription>
                    You will be signed out of SQNR and returned to the sign-in screen.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={signingOut}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={signingOut}
                    className="font-semibold"
                    onClick={async (e) => {
                      e.preventDefault();
                      setSigningOut(true);
                      try {
                        await api.signOut();
                        navigate({ to: "/auth" });
                      } catch {
                        setSigningOut(false);
                      }
                    }}
                  >
                    {signingOut ? "Signing out…" : "Sign out"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </header>

      <section className="mx-auto w-full max-w-5xl px-5 pb-2 pt-8 sm:px-6 sm:pt-12">
        <h1 className="max-w-2xl text-[40px] font-bold leading-[1.05] tracking-[-0.03em] sm:text-6xl">
          Space as a<br />
          service.
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-base">
          Scan any room with your phone. Photos, compass headings and a single acoustic probe become
          a navigable model with dimensions, tagged objects, portals and surface materials.
        </p>

        <Link
          to="/capture"
          className="press mt-7 flex w-full items-center justify-between rounded-2xl bg-primary px-5 py-4 text-primary-foreground shadow-[0_8px_24px_oklch(0.585_0.208_261_/_0.28)] sm:max-w-sm"
        >
          <span className="text-[17px] font-semibold">Add new space</span>
          <span className="flex size-8 items-center justify-center rounded-full bg-white/20">
            <Plus className="size-4" />
          </span>
        </Link>

        {installable && (
          <button
            type="button"
            onClick={() => void install()}
            className="press mt-3 flex w-full items-center justify-between rounded-2xl border border-border bg-card px-5 py-3 text-foreground sm:max-w-sm"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Download className="size-4" aria-hidden />
              Install SQNR to your home screen
            </span>
            <span className="text-xs text-muted-foreground">One-tap capture</span>
          </button>
        )}

        <dl className="mt-8 grid grid-cols-3 gap-3 sm:max-w-lg">
          {[
            ["Spaces", String(totalCount)],
            ["Floor area", `${totalArea.toFixed(1)} m²`],
            // Summed over the spaces loaded so far.
            ["Objects", `${loadedObjects}${list.hasNextPage ? "+" : ""}`],
          ].map(([k, v]) => (
            <div key={k} className="surface-card px-4 py-3">
              <dt className="text-[11px] font-medium text-muted-foreground">{k}</dt>
              <dd className="tabular mt-1 text-lg font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-6">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="pl-1 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Catalog
          </h2>
          {totalCount > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder="Search name, summary, address…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9 pl-9 sm:w-64"
                  aria-label="Search spaces"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
              >
                <SelectTrigger className="h-9 sm:w-[130px]" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="ready">Ready</SelectItem>
                  <SelectItem value="processing">Processing</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="h-9 sm:w-[130px]" aria-label="Sort spaces">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="oldest">Oldest</SelectItem>
                  <SelectItem value="name">Name A–Z</SelectItem>
                  <SelectItem value="area">Largest first</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading spaces…</p>}

        {!isLoading && totalCount === 0 && (
          <div className="surface-card p-10 text-center">
            <p className="text-sm text-muted-foreground">No spaces captured yet.</p>
            <Button asChild className="mt-4 rounded-full">
              <Link to="/capture">
                <Plus className="mr-1 size-4" /> Add new space
              </Link>
            </Button>
          </div>
        )}

        {!isLoading && totalCount > 0 && filteredSpaces.length === 0 && (
          <div className="surface-card p-8 text-center">
            <p className="text-sm text-muted-foreground">No spaces match your filters.</p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredSpaces.map((s) => {
            const thumb = s.thumbnail_url;
            return (
              <div key={s.id} className="relative">
                <Link
                  to="/space/$id"
                  params={{ id: s.id }}
                  className="press surface-card group flex h-full flex-col overflow-hidden p-0"
                >
                  <div className="relative aspect-[16/10] w-full overflow-hidden bg-secondary">
                    {thumb ? (
                      <img
                        src={thumb}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center text-muted-foreground/40">
                        <Boxes className="size-8" />
                      </div>
                    )}
                    <span
                      className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize backdrop-blur ${
                        s.status === "ready"
                          ? "bg-primary/70 text-primary-foreground"
                          : s.status === "failed"
                            ? "bg-destructive/70 text-destructive-foreground"
                            : "bg-black/40 text-white"
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col p-4">
                    <h3 className="text-[17px] font-semibold leading-snug tracking-tight">
                      {s.name}
                    </h3>
                    <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
                      {s.ai_summary ?? "Awaiting reconstruction"}
                    </p>
                    <div className="tabular mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px] text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Ruler className="size-3.5" />
                        {s.width_m && s.length_m
                          ? `${Number(s.width_m).toFixed(1)}×${Number(s.length_m).toFixed(1)} m`
                          : "-"}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Waves className="size-3.5" />
                        {s.rt60_s ? `RT60 ${String(s.rt60_s)}s` : "no probe"}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Boxes className="size-3.5" />
                        {s.object_count} objects
                      </span>
                      <span className="flex items-center gap-1.5">
                        <DoorOpen className="size-3.5" />
                        {s.portal_count} portals
                      </span>
                    </div>
                  </div>
                </Link>
                {/* Outside the Link: a button can't be nested inside an anchor. */}
                <DeleteSpaceDialog
                  scanId={s.id}
                  scanName={s.name}
                  trigger={
                    <button
                      type="button"
                      aria-label={`Delete ${s.name}`}
                      title="Delete space"
                      className="absolute left-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur transition-colors hover:bg-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  }
                />
              </div>
            );
          })}
        </div>
        {list.hasNextPage && (
          <div className="mt-6 flex justify-center">
            <Button
              variant="outline"
              className="rounded-full"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? "Loading…" : "Show more"}
            </Button>
          </div>
        )}
      </section>

      <footer className="mx-auto w-full max-w-5xl px-5 pb-12 pt-10 text-center sm:px-6 sm:pb-16">
        <p className="text-[11px] font-normal text-muted-foreground/40">version {APP_VERSION}</p>
      </footer>

      <AlertDialog
        open={!!reconstructing}
        onOpenChange={(open) => {
          if (!open) void dismissReconstructing();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reconstruction in progress</AlertDialogTitle>
            <AlertDialogDescription>
              {reconstructingName ? `"${reconstructingName}"` : "Your space"} is taking a little
              longer than usual. Your capture is saved and the reconstruction keeps running in the
              background. It will show up as ready in your catalog when it's done.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>OK</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (reconstructing) {
                  void navigate({ to: "/space/$id", params: { id: reconstructing } });
                }
              }}
            >
              View space
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
