"use client";

/**
 * Stand-ins for `@workos-inc/widgets` (hosted account-security UI). Only the
 * password change is meaningful without a hosted identity provider.
 */

import {
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WorkOsWidgets({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  theme?: unknown;
}) {
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

export function UserSecurity(_props: {
  authToken?: string | (() => Promise<string>);
}) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/selfhost-auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword"),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (response.ok) form.reset();
      setMessage({
        ok: response.ok,
        text: response.ok
          ? "Password updated"
          : (result.error ?? "Update failed"),
      });
    } catch {
      setMessage({ ok: false, text: "Network error. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
      <h3 className="font-medium">Change password</h3>
      <div className="space-y-2">
        <Label htmlFor="currentPassword">Current password</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
        />
      </div>
      {message && (
        <p
          role="status"
          className={message.ok ? "text-sm" : "text-destructive text-sm"}
        >
          {message.text}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Update password"}
      </Button>
    </form>
  );
}
