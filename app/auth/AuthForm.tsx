"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "sign-in" | "sign-up";

export function AuthForm({
  mode,
  redirect,
  signupsOpen,
}: {
  mode: Mode;
  redirect?: string;
  signupsOpen: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSignUp = mode === "sign-up";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/selfhost-auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
          firstName: data.get("firstName") || undefined,
          lastName: data.get("lastName") || undefined,
          redirect,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        redirect?: string;
      };
      if (!response.ok) {
        setError(result.error ?? "Something went wrong");
        return;
      }
      // Full navigation: the root layout must re-read the new session cookie.
      // Same-origin paths only, even though the server already validates it.
      const target = new URL(result.redirect ?? "/", window.location.origin);
      window.location.assign(
        target.origin === window.location.origin
          ? `${target.pathname}${target.search}`
          : "/",
      );
    } catch {
      setError("Network error. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center px-5 py-10">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5">
        <h1 className="text-3xl font-semibold">
          {isSignUp ? "Create your account" : "Sign in"}
        </h1>

        {isSignUp && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="firstName">First name</Label>
              <Input
                id="firstName"
                name="firstName"
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" name="lastName" autoComplete="family-name" />
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={isSignUp ? 10 : undefined}
            autoComplete={isSignUp ? "new-password" : "current-password"}
          />
          {isSignUp && (
            <p className="text-muted-foreground text-xs">
              At least 10 characters.
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}
        </Button>

        <p className="text-muted-foreground text-center text-sm">
          {isSignUp ? (
            <>
              Already have an account?{" "}
              <Link className="text-foreground underline" href="/auth/sign-in">
                Sign in
              </Link>
            </>
          ) : signupsOpen ? (
            <>
              No account?{" "}
              <Link className="text-foreground underline" href="/auth/sign-up">
                Create one
              </Link>
            </>
          ) : (
            "Sign-ups are closed on this server."
          )}
        </p>
      </form>
    </main>
  );
}
