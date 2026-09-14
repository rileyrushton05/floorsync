"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { TextField } from "@/components/ui/text-field";
import { useAuth } from "@/core/auth/AuthProvider";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { Wordmark } from "@/core/shell/Logo";

/**
 * Sign in.
 *
 * Posts to the API's own `POST /api/v1/auth/token` and hands the bearer token to
 * the auth store. There is no account creation here because the API has no
 * registration route — accounts are made server-side.
 *
 * `?next=` carries where the visitor was headed before being bounced, so signing
 * in returns them there.
 */

const DEFAULT_MANAGER_DESTINATION = "/manager/simulation";
const DEFAULT_OPERATOR_DESTINATION = "/operator";

function LoginForm() {
    const { status, signIn, user } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();

    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // Only ever follow a same-origin path. `next` comes from the URL, so an
    // absolute one would let a crafted link bounce somebody off-site straight
    // after they typed a password.
    const requested = searchParams.get("next");
    const safeNext =
        requested && requested.startsWith("/") && !requested.startsWith("//") ? requested : null;

    // Anyone already signed in has no business on this page. `next` wins when
    // it points somewhere; otherwise the landing screen depends on the role —
    // an operator sent to the manager-only simulation view would just bounce
    // straight off it again.
    useEffect(() => {
        if (status !== "signedIn") return;
        const destination =
            safeNext ?? (user?.role === "operator" ? DEFAULT_OPERATOR_DESTINATION : DEFAULT_MANAGER_DESTINATION);
        router.replace(destination);
    }, [status, user, router, safeNext]);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setSubmitting(true);
        try {
            await signIn(username, password);
            // Navigation happens in the effect above, once the account resolves.
        } catch (caught: unknown) {
            reportMutationError(caught);
            setSubmitting(false);
        }
    }

    if (status === "signedIn") {
        return (
            <p className="text-center text-muted-fg text-sm">
                Signed in as {user?.name}. Taking you to the app…
            </p>
        );
    }

    return (
        <Card className="w-full max-w-sm">
            <CardHeader>
                <CardTitle>Sign in</CardTitle>
            </CardHeader>
            <CardContent>
                <form onSubmit={submit} className="space-y-4">
                    <TextField
                        name="username"
                        value={username}
                        onChange={setUsername}
                        autoComplete="username"
                    >
                        <Label>Username</Label>
                        <Input autoFocus />
                    </TextField>
                    <TextField
                        name="password"
                        type="password"
                        value={password}
                        onChange={setPassword}
                        autoComplete="current-password"
                    >
                        <Label>Password</Label>
                        <Input />
                    </TextField>

                    <Button
                        type="submit"
                        className="w-full"
                        isPending={submitting}
                        isDisabled={submitting}
                    >
                        {submitting ? "Signing in…" : "Sign in"}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}

export default function LoginPage() {
    return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg p-5 text-fg">
            <Wordmark />
            {/* useSearchParams needs a Suspense boundary to prerender. */}
            <Suspense fallback={<p className="text-muted-fg text-sm">Loading…</p>}>
                <LoginForm />
            </Suspense>
        </div>
    );
}
