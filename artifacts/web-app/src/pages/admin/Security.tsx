import React from "react";
import { format, parseISO } from "date-fns";
import {
  useGetSecurityPolicy,
  useUpdateSecurityPolicy,
  useListSecurityEvents,
  SecurityPolicyInput,
  SecurityEvent,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { ShieldAlert, Save } from "lucide-react";

type PolicyState = {
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireNumber: boolean;
  passwordRequireSymbol: boolean;
  sessionTimeoutMinutes: string;
  mfaRequired: boolean;
  allowedEmailDomains: string;
  blockedEmailDomains: string;
  allowedIps: string;
  allowedCountries: string;
};

function toList(s: string): string[] {
  return s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

function fmt(s?: string | null) {
  if (!s) return "—";
  try {
    return format(parseISO(s), "MMM d, yyyy HH:mm");
  } catch {
    return s;
  }
}

export default function AdminSecurity() {
  const { toast } = useToast();
  const { data: policy, isLoading } = useGetSecurityPolicy();
  const { data: events } = useListSecurityEvents();
  const update = useUpdateSecurityPolicy();

  const [state, setState] = React.useState<PolicyState | null>(null);

  React.useEffect(() => {
    if (policy) {
      setState({
        passwordMinLength: policy.passwordMinLength ?? 8,
        passwordRequireUppercase: policy.passwordRequireUppercase ?? false,
        passwordRequireNumber: policy.passwordRequireNumber ?? false,
        passwordRequireSymbol: policy.passwordRequireSymbol ?? false,
        sessionTimeoutMinutes: policy.sessionTimeoutMinutes != null ? String(policy.sessionTimeoutMinutes) : "",
        mfaRequired: policy.mfaRequired ?? false,
        allowedEmailDomains: (policy.allowedEmailDomains ?? []).join(", "),
        blockedEmailDomains: (policy.blockedEmailDomains ?? []).join(", "),
        allowedIps: (policy.allowedIps ?? []).join(", "),
        allowedCountries: (policy.allowedCountries ?? []).join(", "),
      });
    }
  }, [policy]);

  const set = <K extends keyof PolicyState>(key: K, value: PolicyState[K]) =>
    setState((s) => (s ? { ...s, [key]: value } : s));

  const onSave = () => {
    if (!state) return;
    const data: SecurityPolicyInput = {
      passwordMinLength: Number(state.passwordMinLength) || 8,
      passwordRequireUppercase: state.passwordRequireUppercase,
      passwordRequireNumber: state.passwordRequireNumber,
      passwordRequireSymbol: state.passwordRequireSymbol,
      sessionTimeoutMinutes: state.sessionTimeoutMinutes === "" ? null : Number(state.sessionTimeoutMinutes),
      mfaRequired: state.mfaRequired,
      allowedEmailDomains: toList(state.allowedEmailDomains),
      blockedEmailDomains: toList(state.blockedEmailDomains),
      allowedIps: toList(state.allowedIps),
      allowedCountries: toList(state.allowedCountries),
    };
    update.mutate(
      { data },
      {
        onSuccess: () => toast({ title: "Security policy saved" }),
        onError: () => toast({ variant: "destructive", title: "Failed to save policy" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-7 w-7 text-primary" />
        <h1 className="text-3xl font-bold tracking-tight">Security Center</h1>
      </div>

      <Tabs defaultValue="policy" className="space-y-6">
        <TabsList>
          <TabsTrigger value="policy">Policy</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        <TabsContent value="policy" className="space-y-6">
          {isLoading || !state ? (
            <div className="py-8 text-center text-muted-foreground">Loading policy...</div>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Password & Session</CardTitle>
                  <CardDescription>Minimum requirements enforced at login and password change.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="minlen">Minimum Password Length</Label>
                      <Input id="minlen" type="number" min={6} max={64}
                        value={state.passwordMinLength}
                        onChange={(e) => set("passwordMinLength", Number(e.target.value))} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="timeout">Session Timeout (minutes)</Label>
                      <Input id="timeout" type="number" placeholder="No timeout"
                        value={state.sessionTimeoutMinutes}
                        onChange={(e) => set("sessionTimeoutMinutes", e.target.value)} />
                    </div>
                  </div>
                  <div className="space-y-3 pt-2">
                    <ToggleRow label="Require uppercase letter" checked={state.passwordRequireUppercase}
                      onChange={(v) => set("passwordRequireUppercase", v)} />
                    <ToggleRow label="Require number" checked={state.passwordRequireNumber}
                      onChange={(v) => set("passwordRequireNumber", v)} />
                    <ToggleRow label="Require symbol" checked={state.passwordRequireSymbol}
                      onChange={(v) => set("passwordRequireSymbol", v)} />
                    <ToggleRow label="Require MFA for all users" checked={state.mfaRequired}
                      onChange={(v) => set("mfaRequired", v)} />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Access Restrictions</CardTitle>
                  <CardDescription>Comma- or newline-separated lists. Empty = no restriction.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <ListField label="Allowed Email Domains" placeholder="example.com"
                      value={state.allowedEmailDomains} onChange={(v) => set("allowedEmailDomains", v)} />
                    <ListField label="Blocked Email Domains" placeholder="spam.test"
                      value={state.blockedEmailDomains} onChange={(v) => set("blockedEmailDomains", v)} />
                    <ListField label="Allowed IP Addresses" placeholder="203.0.113.1"
                      value={state.allowedIps} onChange={(v) => set("allowedIps", v)} />
                    <ListField label="Allowed Countries (ISO codes)" placeholder="US, GB"
                      value={state.allowedCountries} onChange={(v) => set("allowedCountries", v)} />
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button onClick={onSave} disabled={update.isPending}>
                  <Save className="mr-2 h-4 w-4" />
                  {update.isPending ? "Saving..." : "Save Policy"}
                </Button>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="events">
          <Card>
            <CardHeader>
              <CardTitle>Security Events</CardTitle>
              <CardDescription>Login blocks, policy changes, and other security activity.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <Table>
                  <TableHeader className="bg-secondary/50">
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>IP</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!events?.events?.length ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No security events.</TableCell>
                      </TableRow>
                    ) : (
                      events.events.map((e: SecurityEvent) => (
                        <TableRow key={e.id}>
                          <TableCell>{fmt(e.createdAt)}</TableCell>
                          <TableCell><Badge variant="secondary" className="capitalize">{e.type.replace(/_/g, " ")}</Badge></TableCell>
                          <TableCell className="text-sm">{e.description}</TableCell>
                          <TableCell className="font-mono text-xs">{e.ipAddress ?? "—"}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <span className="text-sm font-medium">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function ListField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
