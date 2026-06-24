import React from "react";
import { Link, useLocation, useParams } from "wouter";
import { Camera, ArrowLeft, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/PasswordInput";
import {
  useGetInvitationByToken,
  getGetInvitationByTokenQueryKey,
  useAcceptInvitation,
  useRejectInvitation,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export default function AcceptInvite() {
  const params = useParams();
  const token = params.token ?? "";
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data, isLoading, isError } = useGetInvitationByToken(token, { query: { enabled: !!token, retry: false, queryKey: getGetInvitationByTokenQueryKey(token) } });
  const accept = useAcceptInvitation();
  const reject = useRejectInvitation();

  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [accepted, setAccepted] = React.useState(false);
  const [rejected, setRejected] = React.useState(false);

  const invitation = data?.invitation;
  React.useEffect(() => {
    if (invitation?.name) setName(invitation.name);
  }, [invitation?.name]);

  const handleAccept = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    accept.mutate(
      { data: { token, name, password } },
      {
        onSuccess: () => setAccepted(true),
        onError: (err: any) =>
          toast({ title: "Could not accept invitation", description: err?.message, variant: "destructive" }),
      },
    );
  };

  const handleReject = () => {
    reject.mutate(
      { data: { token } },
      {
        onSuccess: () => setRejected(true),
        onError: (err: any) =>
          toast({ title: "Could not decline invitation", description: err?.message, variant: "destructive" }),
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

        {isLoading ? (
          <div className="text-center py-8">
            <Loader2 className="h-8 w-8 text-primary animate-spin mx-auto" />
          </div>
        ) : isError || !invitation ? (
          <div className="text-center space-y-4 py-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <XCircle className="h-6 w-6 text-destructive" />
            </div>
            <h1 className="text-xl font-semibold">Invitation unavailable</h1>
            <p className="text-sm text-muted-foreground">This invitation is invalid, has expired, or was already used.</p>
            <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Go to sign in
            </Link>
          </div>
        ) : accepted ? (
          <div className="text-center space-y-4 py-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold">Welcome aboard!</h1>
            <p className="text-sm text-muted-foreground">
              Your account has been created. You can now sign in to {invitation.companyName ?? "your team"}.
            </p>
            <Button className="w-full" onClick={() => setLocation("/login")}>
              Go to sign in
            </Button>
          </div>
        ) : rejected ? (
          <div className="text-center space-y-4 py-4">
            <h1 className="text-xl font-semibold">Invitation declined</h1>
            <p className="text-sm text-muted-foreground">You've declined this invitation. No account was created.</p>
            <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Go to sign in
            </Link>
          </div>
        ) : invitation.status !== "pending" ? (
          <div className="text-center space-y-4 py-4">
            <h1 className="text-xl font-semibold">Invitation no longer active</h1>
            <p className="text-sm text-muted-foreground">This invitation has already been {invitation.status}.</p>
            <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Go to sign in
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-1">You're invited</h1>
            <p className="text-sm text-muted-foreground mb-6">
              Join <span className="font-medium">{invitation.companyName ?? "the team"}</span> on Card Scanner Pro. Set up
              your account for <span className="font-medium">{invitation.email}</span>.
            </p>
            <form onSubmit={handleAccept} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Your Name</Label>
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <PasswordInput id="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">Confirm Password</Label>
                <PasswordInput id="confirm" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={accept.isPending}>
                {accept.isPending ? "Creating account..." : "Accept & create account"}
              </Button>
            </form>
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={handleReject}
                disabled={reject.isPending}
                className="text-sm text-muted-foreground hover:text-destructive hover:underline"
              >
                Decline invitation
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
