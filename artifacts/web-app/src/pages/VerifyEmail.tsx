import React from "react";
import { Link } from "wouter";
import { Camera, ArrowLeft, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useVerifyEmail } from "@workspace/api-client-react";

export default function VerifyEmail() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const verify = useVerifyEmail();
  const [status, setStatus] = React.useState<"pending" | "success" | "error">("pending");
  const ranRef = React.useRef(false);

  React.useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (!token) {
      setStatus("error");
      return;
    }
    verify.mutate(
      { data: { token } },
      {
        onSuccess: () => setStatus("success"),
        onError: () => setStatus("error"),
      },
    );
  }, [token, verify]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB] p-4">
      <div className="w-full max-w-md bg-card rounded-xl border border-border shadow-sm p-8 text-center">
        <div className="flex items-center justify-center gap-2 text-primary mb-6">
          <Camera className="h-6 w-6" />
          <span className="font-bold text-lg tracking-tight">Card Scanner Pro</span>
        </div>

        {status === "pending" && (
          <div className="space-y-4 py-4">
            <Loader2 className="h-8 w-8 text-primary animate-spin mx-auto" />
            <p className="text-sm text-muted-foreground">Verifying your email…</p>
          </div>
        )}

        {status === "success" && (
          <div className="space-y-4 py-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold">Email verified</h1>
            <p className="text-sm text-muted-foreground">Your email address has been confirmed.</p>
            <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Continue to sign in
            </Link>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-4 py-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <XCircle className="h-6 w-6 text-destructive" />
            </div>
            <h1 className="text-xl font-semibold">Verification failed</h1>
            <p className="text-sm text-muted-foreground">
              This verification link is invalid or has expired. You can request a new one from your profile after signing
              in.
            </p>
            <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
