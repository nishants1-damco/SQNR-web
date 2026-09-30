// Password reset. Without a token: ask for the email (the API always answers
// the same way, so this can't reveal who has an account). With the token from
// the emailed link: set the new password, which also signs out every session.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/api/client";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth_/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search["token"] === "string" ? { token: search["token"] } : {},
  head: () => ({ meta: [{ title: "Reset your password · SQNR" }] }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (token) {
        await api.request("POST", "/v1/auth/password-reset/confirm", {
          body: { token, password },
          auth: false,
        });
        toast.success("Password changed. Sign in with your new password.");
        await navigate({ to: "/auth" });
      } else {
        await api.request("POST", "/v1/auth/password-reset", { body: { email }, auth: false });
        setSent(true);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="surface-card w-full max-w-sm p-6">
        <Link to="/">
          <BrandMark />
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">
          {token ? "Choose a new password" : "Reset your password"}
        </h1>
        {sent ? (
          <p className="mt-2 text-sm text-muted-foreground">
            If an account uses {email}, we've sent it a link to reset the password. The link works
            for an hour.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            {token ? (
              <div className="space-y-1.5">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  minLength={6}
                  autoComplete="new-password"
                  required
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  autoComplete="email"
                  required
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Working…" : token ? "Set password" : "Send reset link"}
            </Button>
          </form>
        )}
        <Link
          to="/auth"
          className="mt-5 block text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
