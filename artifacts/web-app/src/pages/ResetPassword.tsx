import React from "react";
import { Link, useLocation } from "wouter";
import { Camera, ArrowLeft, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/PasswordInput";
import { useResetPassword } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

function useToken(): string {
  const [location] = useLocation();
  // Token is delivered as ?token=... The wouter location excludes the query, so
  // read it from the actual browser URL.
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

export default function ResetPassword() {
  const token = useToken();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [done, setDone] = React.useState(false);
  const reset = useResetPassword();

  // Mirror the server's password policy client-side for immediate feedback; the
  // server remains the authority.
  const clientPasswordErrors = (pw: string): string[] => {
    const errs: string[] = [];
    if (pw.length < 8) errs.push("at least 8 characters");
    if (!/[a-z]/.test(pw)) errs.push("a lowercase letter");
    if (!/[A-Z]/.test(pw)) errs.push("an uppercase letter");
    if (!/[0-9]/.test(pw)) errs.push("a number");
    return errs;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = clientPasswordErrors(password);
    if (errs.length > 0) {
      toast({ title: "Password too weak", description: `Password needs ${errs.join(", ")}.`, variant: "destructive" });
      return;
    }
    if (password !== confirm) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    reset.mutate(
      { data: { token, newPassword: password } },
      {
        onSuccess: () => setDone(true),
        onError: (err: any) => {
          toast({
            title: "Could not reset password",
            description: err?.message ?? "The link may be invalid or expired.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB] p-4">
      <div className="w-full max-w-md bg-card rounded-xl border border-border shadow-sm p-8">
        <div className="flex items-center gap-2 text-primary mb-6">
          <Camera className="h-6 w-6" />
          <span className="font-bold text-lg tracking-tight">Card Scanner Pro</span>
        </div>

        {done ? (
          <div className="text-center space-y-4 py-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold">Password reset</h1>
            <p className="text-sm text-muted-foreground">
              Your password has been updated. You can now sign in with your new password.
            </p>
            <Button className="w-full" onClick={() => setLocation("/login")}>
              Go to sign in
            </Button>
          </div>
        ) : !token ? (
          <div className="text-center space-y-4 py-4">
            <h1 className="text-xl font-semibold">Invalid link</h1>
            <p className="text-sm text-muted-foreground">This reset link is missing its token. Please request a new one.</p>
            <Link href="/forgot-password" className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Request a new link
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-1">Set a new password</h1>
            <p className="text-sm text-muted-foreground mb-6">
              Choose a strong password with upper and lower case letters, a number, and a symbol.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">New Password</Label>
                <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">Confirm Password</Label>
                <PasswordInput id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={reset.isPending}>
                {reset.isPending ? "Resetting..." : "Reset password"}
              </Button>
            </form>
            <div className="mt-6 text-center">
              <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
