"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { OwnerLogin } from "@/contracts";
import { ownerLogin } from "@/ui-lib/api";
import { IconAlert } from "../icons";

type Field = "username" | "password";

function safeNext(): string {
  try {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && /^\/owner(\/[A-Za-z0-9/_-]*)?$/.test(next) && !next.startsWith("/owner/login")) {
      return next;
    }
  } catch {
    // ignore
  }
  return "/owner";
}

export function OwnerLoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFailure(null);
    const parsed = OwnerLogin.safeParse({ username, password });
    if (!parsed.success) {
      const errs: Partial<Record<Field, string>> = {};
      for (const i of parsed.error.issues) {
        const k = i.path[0] as Field;
        if (!errs[k]) errs[k] = i.message;
      }
      setErrors(errs);
      (errs.username ? userRef : passRef).current?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    const res = await ownerLogin(parsed.data);
    if (res.ok) {
      router.replace(safeNext());
      router.refresh();
      return;
    }
    setBusy(false);
    setPassword("");
    setFailure(
      res.status === 429
        ? "Too many sign-in attempts. Wait a few minutes, then try again."
        : res.status === 0
          ? "We couldn't reach Oasis. Check your connection and try again."
          : res.status >= 500
            ? "Something went wrong on our side. Please try again."
            : "That username and password don't match.",
    );
    requestAnimationFrame(() => passRef.current?.focus());
  };

  return (
    <form className="panel stack" noValidate onSubmit={(e) => void onSubmit(e)}>
      {failure && (
        <div className="notice notice--danger" role="alert" id="login-error">
          <IconAlert />
          <span>{failure}</span>
        </div>
      )}
      <div className="field">
        <label className="field__label" htmlFor="owner-username">
          Username
        </label>
        <input
          ref={userRef}
          id="owner-username"
          name="username"
          className="input"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-required="true"
          aria-invalid={errors.username ? true : undefined}
          aria-describedby={errors.username ? "owner-username-error" : undefined}
        />
        {errors.username && (
          <p className="field__error" id="owner-username-error">
            <IconAlert />
            <span>{errors.username}</span>
          </p>
        )}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="owner-password">
          Password
        </label>
        <input
          ref={passRef}
          id="owner-password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-required="true"
          aria-invalid={errors.password || failure ? true : undefined}
          aria-describedby={
            [errors.password ? "owner-password-error" : "", failure ? "login-error" : ""]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
        {errors.password && (
          <p className="field__error" id="owner-password-error">
            <IconAlert />
            <span>{errors.password}</span>
          </p>
        )}
      </div>
      <button
        type="submit"
        className="btn btn--block"
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {busy && <span className="spinner" aria-hidden="true" />}
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
