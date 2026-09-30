// Target of the verification link the API emails after sign-up
// (`/auth/verify-email?token=`). Verifying is optional: sign-in never waits
// for it, as with the Supabase setup this replaces.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/api/client";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/auth_/verify-email")({
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search["token"] === "string" ? { token: search["token"] } : {},
  head: () => ({ meta: [{ title: "Verify your email · SQNR" }] }),
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { token } = Route.useSearch();
  const [state, setState] = useState<"working" | "done" | "failed">(token ? "working" : "failed");
  const [message, setMessage] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    // The token is single-use: don't redeem it twice (StrictMode runs effects twice).
    if (!token || sent.current) return;
    sent.current = true;
    api
      .request("POST", "/v1/auth/verify-email", { body: { token }, auth: false })
      .then(() => setState("done"))
      .catch((err: unknown) => {
        setState("failed");
        setMessage(err instanceof ApiError ? err.message : "This link didn't work.");
      });
  }, [token]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="surface-card w-full max-w-sm p-6">
        <Link to="/">
          <BrandMark />
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">
          {state === "working"
            ? "Verifying…"
            : state === "done"
              ? "Email verified"
              : "Link not valid"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {state === "done"
            ? "Thanks, your email address is confirmed."
            : state === "failed"
              ? (message ?? "This verification link is invalid or has expired.")
              : "One moment."}
        </p>
        {state !== "working" && (
          <Button asChild className="mt-6 w-full">
            <Link to="/">Continue</Link>
          </Button>
        )}
      </div>
    </main>
  );
}
