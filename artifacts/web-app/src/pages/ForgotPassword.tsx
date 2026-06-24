import React from "react";
import { Link } from "wouter";
import { Camera, ArrowLeft, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForgotPassword } from "@workspace/api-client-react";

export default function ForgotPassword() {
  const [email, setEmail] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const forgot = useForgotPassword();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    forgot.mutate({ data: { email } }, { onSettled: () => setSubmitted(true) });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8F9FB] p-4">
      <div className="w-full max-w-md bg-card rounded-xl border border-border shadow-sm p-8">
        <div className="flex items-center gap-2 text-primary mb-6">
          <Camera className="h-6 w-6" />
          <span className="font-bold text-lg tracking-tight">Card Scanner Pro</span>
        </div>

        {submitted ? (
          <div className="text-center space-y-4 py-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <MailCheck className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-xl font-semibold">Check your email</h1>
            <p className="text-sm text-muted-foreground">
              If an account exists for <span className="font-medium">{email}</span>, we've sent a link to reset your
              password. The link expires shortly for your security.
            </p>
            <Link href="/login" className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-1">Forgot your password?</h1>
            <p className="text-sm text-muted-foreground mb-6">
              Enter your work email and we'll send you a link to reset your password.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Work Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={forgot.isPending}>
                {forgot.isPending ? "Sending..." : "Send reset link"}
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
