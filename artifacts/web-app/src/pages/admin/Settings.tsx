import React from "react";
import { Link } from "wouter";
import { ShieldCheck, ShieldOff, KeyRound, Monitor, Loader2, Copy, Check } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PasswordInput } from "@/components/PasswordInput";
import { PasswordStrength, isPasswordStrong } from "@/components/PasswordStrength";
import {
  useGetMfaStatus,
  useMfaSetup,
  useMfaEnable,
  useMfaDisable,
  useChangePassword,
  useRegenerateBackupCodes,
  type MfaSetupData,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

function BackupCodes({ codes }: { codes: string[] }) {
  const { toast } = useToast();
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Copy the codes manually." });
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Your backup codes</p>
        <Button variant="ghost" size="sm" onClick={copy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((c) => (
          <span key={c} className="rounded bg-background px-2 py-1 text-center">
            {c}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Store these somewhere safe. Each code works once and lets you sign in if you lose your
        authenticator.
      </p>
    </div>
  );
}

function ChangePasswordCard() {
  const { toast } = useToast();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const changePassword = useChangePassword();

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit =
    current.length > 0 && isPasswordStrong(next) && next === confirm && !changePassword.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    changePassword.mutate(
      { data: { currentPassword: current, newPassword: next } },
      {
        onSuccess: () => {
          toast({ title: "Password updated", description: "Your password has been changed." });
          setCurrent("");
          setNext("");
          setConfirm("");
        },
        onError: (error: any) => {
          toast({
            variant: "destructive",
            title: "Could not change password",
            description: error?.data?.error || "Check your current password and try again.",
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          Password
        </CardTitle>
        <CardDescription>Use a strong, unique password for your account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">Current password</Label>
            <PasswordInput
              id="currentPassword"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">New password</Label>
            <PasswordInput
              id="newPassword"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
            <PasswordStrength value={next} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <PasswordInput
              id="confirmPassword"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className={mismatch ? "border-destructive focus-visible:ring-destructive" : ""}
            />
            {mismatch && <p className="text-sm text-destructive">Passwords do not match.</p>}
          </div>
          <Button type="submit" disabled={!canSubmit}>
            {changePassword.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MfaCard() {
  const { toast } = useToast();
  const { data: status, isLoading, refetch } = useGetMfaStatus();

  const [setupData, setSetupData] = React.useState<MfaSetupData | null>(null);
  const [enableCode, setEnableCode] = React.useState("");
  const [backupCodes, setBackupCodes] = React.useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = React.useState("");
  const [showDisable, setShowDisable] = React.useState(false);

  const setup = useMfaSetup();
  const enable = useMfaEnable();
  const disable = useMfaDisable();
  const regenerate = useRegenerateBackupCodes();

  const startSetup = () => {
    setBackupCodes(null);
    setup.mutate(undefined, {
      onSuccess: (data) => setSetupData(data),
      onError: () =>
        toast({ variant: "destructive", title: "Setup failed", description: "Please try again." }),
    });
  };

  const confirmEnable = (e: React.FormEvent) => {
    e.preventDefault();
    if (enableCode.trim().length < 6) return;
    enable.mutate(
      { data: { code: enableCode.trim() } },
      {
        onSuccess: (res) => {
          setSetupData(null);
          setEnableCode("");
          setBackupCodes(res.backupCodes);
          toast({ title: "Two-factor enabled", description: "Save your backup codes." });
          refetch();
        },
        onError: (error: any) =>
          toast({
            variant: "destructive",
            title: "Verification failed",
            description: error?.data?.error || "Invalid code. Try again.",
          }),
      },
    );
  };

  const confirmDisable = (e: React.FormEvent) => {
    e.preventDefault();
    if (!disablePassword) return;
    disable.mutate(
      { data: { password: disablePassword } },
      {
        onSuccess: () => {
          setShowDisable(false);
          setDisablePassword("");
          setBackupCodes(null);
          toast({ title: "Two-factor disabled", description: "MFA has been turned off." });
          refetch();
        },
        onError: (error: any) =>
          toast({
            variant: "destructive",
            title: "Could not disable MFA",
            description: error?.data?.error || "Check your password and try again.",
          }),
      },
    );
  };

  const regenerateCodes = () => {
    const password = window.prompt("Enter your account password to regenerate backup codes:");
    if (!password) return;
    regenerate.mutate(
      { data: { password } },
      {
        onSuccess: (res) => {
          setBackupCodes(res.backupCodes);
          toast({ title: "Backup codes regenerated", description: "Your old codes no longer work." });
          refetch();
        },
        onError: (error: any) =>
          toast({
            variant: "destructive",
            title: "Could not regenerate codes",
            description: error?.data?.error || "Check your password and try again.",
          }),
      },
    );
  };

  const enabled = status?.enabled ?? false;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              {enabled ? <ShieldCheck className="h-5 w-5 text-emerald-600" /> : <ShieldOff className="h-5 w-5" />}
              Two-factor authentication
            </CardTitle>
            <CardDescription className="mt-1">
              Add a second step to your login using an authenticator app.
            </CardDescription>
          </div>
          {!isLoading && (
            <Badge variant={enabled ? "default" : "secondary"}>
              {enabled ? "Enabled" : "Disabled"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            {status?.companyRequired && !enabled && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Your company requires two-factor authentication. Please enable it now.
              </div>
            )}

            {backupCodes && <BackupCodes codes={backupCodes} />}

            {/* Not enabled, not mid-setup */}
            {!enabled && !setupData && (
              <Button onClick={startSetup} disabled={setup.isPending}>
                {setup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Set up two-factor
              </Button>
            )}

            {/* Mid-setup: show QR + enter code */}
            {!enabled && setupData && (
              <form onSubmit={confirmEnable} className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-6 items-start">
                  <img
                    src={setupData.qrDataUrl}
                    alt="Scan this QR code with your authenticator app"
                    className="w-44 h-44 rounded-lg border border-border bg-white p-2"
                  />
                  <div className="space-y-2 text-sm">
                    <p className="font-medium">Scan the QR code</p>
                    <p className="text-muted-foreground">
                      Use Google Authenticator, 1Password, Authy, or similar. Can't scan? Enter this
                      key manually:
                    </p>
                    <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                      {setupData.secret}
                    </code>
                  </div>
                </div>
                <div className="space-y-2 max-w-xs">
                  <Label htmlFor="enableCode">Enter the 6-digit code</Label>
                  <Input
                    id="enableCode"
                    autoFocus
                    autoComplete="one-time-code"
                    placeholder="123456"
                    value={enableCode}
                    onChange={(e) => setEnableCode(e.target.value)}
                    className="tracking-widest text-lg"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={enable.isPending || enableCode.trim().length < 6}>
                    {enable.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Verify & enable
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => { setSetupData(null); setEnableCode(""); }}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {/* Enabled state */}
            {enabled && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {status?.backupCodesRemaining ?? 0} backup code(s) remaining.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={regenerateCodes} disabled={regenerate.isPending}>
                    Regenerate backup codes
                  </Button>
                  {!showDisable && (
                    <Button variant="outline" className="text-destructive" onClick={() => setShowDisable(true)}>
                      Disable two-factor
                    </Button>
                  )}
                </div>

                {showDisable && (
                  <form onSubmit={confirmDisable} className="space-y-3 max-w-md rounded-lg border border-border p-4">
                    <Label htmlFor="disablePassword">Confirm your password to disable MFA</Label>
                    <PasswordInput
                      id="disablePassword"
                      value={disablePassword}
                      onChange={(e) => setDisablePassword(e.target.value)}
                      autoComplete="current-password"
                    />
                    <div className="flex gap-2">
                      <Button type="submit" variant="destructive" disabled={disable.isPending || !disablePassword}>
                        {disable.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Disable
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => { setShowDisable(false); setDisablePassword(""); }}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminSettings() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Company Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Configure company preferences here.</p>
        </CardContent>
      </Card>

      <Separator />

      <div>
        <h2 className="text-xl font-semibold tracking-tight mb-1">Security</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Manage your password, two-factor authentication, and signed-in devices.
        </p>
      </div>

      <ChangePasswordCard />
      <MfaCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            Active sessions
          </CardTitle>
          <CardDescription>Review and sign out devices connected to your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link href="/admin/sessions">Manage sessions</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
