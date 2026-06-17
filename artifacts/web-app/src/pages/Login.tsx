import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation } from "wouter";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin, UserRole } from "@workspace/api-client-react";
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

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onSubmit = (data: LoginForm) => {
    loginMutation.mutate({ data }, {
      onSuccess: (response) => {
        login(response.user, response.token);
        toast({
          title: "Login successful",
          description: `Welcome back, ${response.user.name}`,
        });
        if (response.user.role === UserRole.platform_owner) {
          setLocation("/platform");
        } else {
          setLocation("/admin");
        }
      },
      onError: (error: any) => {
        toast({
          variant: "destructive",
          title: "Login failed",
          description: error?.error || "Invalid credentials",
        });
      }
    });
  };

  const handleDemoLogin = (role: "platform" | "admin") => {
    const email = role === "platform" ? "admin@cardscannerpro.com" : "admin@techcorp.com";
    const password = "Admin123!";
    form.setValue("email", email);
    form.setValue("password", password);
    loginMutation.mutate({ data: { email, password } }, {
      onSuccess: (response) => {
        login(response.user, response.token);
        if (response.user.role === UserRole.platform_owner) {
          setLocation("/platform");
        } else {
          setLocation("/admin");
        }
      },
      onError: () => {
        toast({ variant: "destructive", title: "Demo login failed", description: "Please try again." });
      }
    });
  };

  return (
    <div className="min-h-screen w-full flex bg-background">
      {/* Left side - Form */}
      <div className="w-full md:w-[480px] lg:w-[540px] flex flex-col justify-center px-8 md:px-12 lg:px-16 border-r border-border bg-card relative z-10 shadow-2xl">
        <div className="flex items-center gap-2 text-primary mb-12">
          <Camera className="h-8 w-8" />
          <span className="font-bold text-2xl tracking-tight text-foreground">Card Scanner Pro</span>
        </div>

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
              <a href="#" className="text-xs text-primary font-medium hover:underline">Forgot password?</a>
            </div>
            <Input 
              id="password" 
              type="password" 
              {...form.register("password")}
              className={form.formState.errors.password ? "border-destructive focus-visible:ring-destructive" : ""}
            />
            {form.formState.errors.password && (
              <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
            )}
          </div>

          <Button 
            type="submit" 
            className="w-full h-11 text-base font-semibold"
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending ? "Signing in..." : "Sign in"}
          </Button>
        </form>

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
