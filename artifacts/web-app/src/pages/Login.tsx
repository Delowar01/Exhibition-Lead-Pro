import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation } from "wouter";
import { Camera, ShieldCheck, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { PasswordInput } from "@/components/PasswordInput";
import {
  useLogin,
  useMfaVerifyLogin,
  UserRole,
  type AuthResponse,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const { login } = useAuth();
  const { toast } = useToast();
  const loginMutation = useLogin();
  const verifyMfaMutation = useMfaVerifyLogin();

  const [rememberMe, setRememberMe] = React.useState(false);
  const [mfaToken, setMfaToken] = React.useState<string | null>(null);
  const [mfaCode, setMfaCode] = React.useState("");
  const [rememberDevice, setRememberDevice] = React.useState(false);

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const completeAuth = (response: AuthResponse) => {
    if (!response.token || !response.user) return;
    login(response.user, response.token, response.refreshToken);
    toast({
      title: "Login successful",
      description: `Welcome back, ${response.user.name}`,
    });
    if (response.user.role === UserRole.platform_owner) {
      setLocation("/platform");
    } else {
      setLocation("/admin");
    }
  };

  const handleAuthResponse = (response: AuthResponse) => {
    if (response.mfaEnrollmentRequired) {
      toast({
        variant: "destructive",
        title: "Two-factor setup required",
        description:
          "Your organization requires two-factor authentication. Please contact your administrator to complete enrollment before signing in.",
      });
      return;
    }
    if (response.mfaRequired && response.mfaToken) {
      setMfaToken(response.mfaToken);
      setMfaCode("");
      return;
    }
    completeAuth(response);
  };

  const onSubmit = (data: LoginForm) => {
    loginMutation.mutate(
      { data: { ...data, rememberMe } },
      {
        onSuccess: handleAuthResponse,
        onError: (error: any) => {
          toast({
            variant: "destructive",
            title: "Login failed",
            description: error?.data?.error || error?.message || "Invalid credentials",
          });
        },
      },
    );
  };

  const onVerifyMfa = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaToken || mfaCode.trim().length < 6) return;
    verifyMfaMutation.mutate(
      { data: { mfaToken, code: mfaCode.trim(), rememberMe, rememberDevice } },
      {
        onSuccess: completeAuth,
        onError: (error: any) => {
          toast({
            variant: "destructive",
            title: "Verification failed",
            description: error?.data?.error || "Invalid or expired code. Try again.",
          });
        },
      },
    );
  };

  const handleDemoLogin = (role: "platform" | "admin") => {
    const email = role === "platform" ? "admin@cardscannerpro.com" : "admin@techcorp.com";
    const password = "Admin123!";
    form.setValue("email", email);
    form.setValue("password", password);
    loginMutation.mutate(
      { data: { email, password, rememberMe } },
      {
        onSuccess: handleAuthResponse,
        onError: () => {
          toast({ variant: "destructive", title: "Demo login failed", description: "Please try again." });
        },
      },
    );
  };

  const inMfaStep = mfaToken !== null;

  return (
    <div className="min-h-screen w-full flex bg-background">
      {/* Left side - Form */}
      <div className="w-full md:w-[480px] lg:w-[540px] flex flex-col justify-center px-8 md:px-12 lg:px-16 border-r border-border bg-card relative z-10 shadow-2xl">
        <div className="flex items-center gap-2 text-primary mb-12">
          <Camera className="h-8 w-8" />
          <span className="font-bold text-2xl tracking-tight text-foreground">Card Scanner Pro</span>
        </div>

        {!inMfaStep ? (
          <>
            <div className="mb-8">
              <h1 className="text-3xl font-bold tracking-tight mb-2">Welcome back</h1>
              <p className="text-muted-foreground">Sign in to your account to continue.</p>
            </div>

            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 mb-8">
              <div className="space-y-2">
                <Label htmlFor="email">Work Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="name@company.com"
                  {...form.register("email")}
                  className={form.formState.errors.email ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {form.formState.errors.email && (
                  <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <Label htmlFor="password">Password</Label>
                  <button type="button" onClick={() => setLocation("/forgot-password")} className="text-xs text-primary font-medium hover:underline">Forgot password?</button>
                </div>
                <PasswordInput
                  id="password"
                  {...form.register("password")}
                  className={form.formState.errors.password ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {form.formState.errors.password && (
                  <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="rememberMe"
                  checked={rememberMe}
                  onCheckedChange={(v) => setRememberMe(v === true)}
                />
                <Label htmlFor="rememberMe" className="text-sm font-normal cursor-pointer">
                  Keep me signed in
                </Label>
              </div>

              <Button
                type="submit"
                className="w-full h-11 text-base font-semibold"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? "Signing in..." : "Sign in"}
              </Button>
            </form>

            {/* Demo quick-login against seeded dev/staging accounts. Rendered in
                development builds only — production bundles exclude it entirely. */}
            {import.meta.env.DEV && (
              <div className="space-y-4 pt-6 border-t border-border">
                <p className="text-sm text-muted-foreground font-medium uppercase tracking-wider text-center mb-4">Quick Demo Login</p>
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    variant="outline"
                    onClick={() => handleDemoLogin("admin")}
                    type="button"
                    className="text-xs"
                  >
                    Company Admin
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleDemoLogin("platform")}
                    type="button"
                    className="text-xs"
                  >
                    Platform Owner
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mb-8">
              <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <h1 className="text-3xl font-bold tracking-tight mb-2">Two-factor authentication</h1>
              <p className="text-muted-foreground">
                Enter the 6-digit code from your authenticator app, or a backup code.
              </p>
            </div>

            <form onSubmit={onVerifyMfa} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="mfaCode">Verification code</Label>
                <Input
                  id="mfaCode"
                  inputMode="text"
                  autoFocus
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  className="tracking-widest text-lg"
                />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="rememberDevice"
                  checked={rememberDevice}
                  onCheckedChange={(v) => setRememberDevice(v === true)}
                />
                <Label htmlFor="rememberDevice" className="text-sm font-normal cursor-pointer">
                  Trust this device for 30 days
                </Label>
              </div>

              <Button
                type="submit"
                className="w-full h-11 text-base font-semibold"
                disabled={verifyMfaMutation.isPending || mfaCode.trim().length < 6}
              >
                {verifyMfaMutation.isPending ? "Verifying..." : "Verify & sign in"}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setMfaToken(null);
                  setMfaCode("");
                }}
              >
                <ArrowLeft className="h-4 w-4" />
                Back to sign in
              </Button>
            </form>
          </>
        )}
      </div>

      {/* Right side - Branding */}
      <div className="hidden md:flex flex-1 bg-sidebar flex-col items-center justify-center p-12 relative overflow-hidden">
        {/* Abstract decorative elements */}
        <div className="absolute top-[-10%] right-[-5%] w-[600px] h-[600px] rounded-full bg-primary/10 blur-[100px] pointer-events-none" />
        <div className="absolute bottom-[-10%] left-[-5%] w-[500px] h-[500px] rounded-full bg-blue-500/10 blur-[100px] pointer-events-none" />

        <div className="max-w-xl text-center relative z-10">
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-6 leading-tight">
            Stop losing leads to the bottom of your bag.
          </h2>
          <p className="text-lg text-sidebar-foreground/70 mb-12">
            The enterprise scanner built for high-volume networking. Instantly digitize, qualify, and route contacts to your CRM pipeline.
          </p>

          <div className="bg-sidebar-accent/50 border border-sidebar-border backdrop-blur-md p-6 rounded-xl text-left flex gap-6 items-center shadow-2xl">
            <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
              <Camera className="text-primary w-8 h-8" />
            </div>
            <div>
              <h3 className="text-white font-semibold text-lg mb-1">99.9% Extraction Accuracy</h3>
              <p className="text-sidebar-foreground/60 text-sm">Powered by advanced OCR and machine learning, ensuring every detail is captured perfectly.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
