import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Info, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  getGetPlatformAiProvidersQueryKey,
  getListCompaniesQueryKey,
  useGetPlatformAiProviders,
  useListCompanies,
  useUpdatePlatformAiProviders,
  type PlatformAiPolicy,
  type PlatformAiProviders,
  type PlatformAiProviderStatus,
} from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Caption, CardGridSkeleton, ErrorState, SectionTitle, StatusBadge, SubsectionTitle } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { formatMicroUsd } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  PROVIDERS,
  PROVIDER_LABEL,
  PROVIDER_VENDOR,
  compactNumber,
  credentialSummary,
  describeSaveFailure,
  draftFromStatus,
  draftToPolicy,
  isDirty,
  limitSummary,
  modelPriceLabel,
  providerRole,
  providerStatus,
  serverDate,
  servingSummary,
  usesTestModel,
  type DraftErrors,
  type PolicyDraft,
  type ProviderDraft,
  type ProviderName,
  type Tone,
} from "@/lib/ai-providers";

// Platform Owner → Settings → AI Providers.
//
// The page edits ONE document — the platform's AI provider policy — and saves it whole,
// with the version it was read at. Everything shown about a provider (whether a key is on
// the server, what it has cost this month) is read from the API; nothing is simulated and
// no key is ever typed, shown or sent here. The server decides which changes need a
// confirmation: a save it holds back comes back with its reasons, and the dialog shows
// exactly those.

const PROVIDER_MODEL = "__provider_model__";

const TONE_SURFACE: Record<Tone, string> = {
  success: "border-success/25 bg-success-soft",
  warning: "border-warning/25 bg-warning-soft",
  info: "border-info/25 bg-info-soft",
  destructive: "border-destructive/25 bg-destructive-soft",
  primary: "border-primary/25 bg-primary-soft",
  neutral: "border-border bg-muted",
};

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground [overflow-wrap:anywhere]" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function ProviderCard({
  provider,
  status,
  info,
  draft,
  limitError,
  disabled,
  onChange,
}: {
  provider: ProviderName;
  status: PlatformAiProviders;
  info: PlatformAiProviderStatus;
  draft: ProviderDraft;
  limitError?: string;
  disabled: boolean;
  onChange: (patch: Partial<ProviderDraft>) => void;
}) {
  const role = providerRole(status, provider);
  const cred = credentialSummary(info);
  const limit = limitSummary(info);
  const selected = info.models.find((m) => m.id === draft.model);
  const month = info.month;
  const id = (s: string) => `ai-${s}-${provider}`;

  return (
    <Card data-testid={id("provider")}>
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
              {PROVIDER_LABEL[provider]}
              <StatusBadge tone={role.tone} className="font-medium" >
                <span data-testid={id("role")}>{role.label}</span>
              </StatusBadge>
            </CardTitle>
            <CardDescription>{PROVIDER_VENDOR[provider]}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor={id("enable")} className="text-sm font-normal text-muted-foreground">
              {draft.enabled ? "Enabled" : "Disabled"}
            </Label>
            <Switch
              id={id("enable")}
              data-testid={id("enable")}
              aria-label={`${PROVIDER_LABEL[provider]} enabled`}
              checked={draft.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) => onChange({ enabled })}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className={cn("rounded-lg border p-3", TONE_SURFACE[cred.tone])} data-testid={id("credentials")}>
          <div className="flex flex-wrap items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">API key</span>
            <StatusBadge tone={cred.tone}>{cred.label}</StatusBadge>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{cred.detail}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={id("model")}>Model</Label>
          <Select value={draft.model} onValueChange={(model) => onChange({ model })} disabled={disabled}>
            <SelectTrigger id={id("model")} data-testid={id("model")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {info.models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.id}
                  {m.simulated ? " (test)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Caption>
            <span data-testid={id("price")}>{modelPriceLabel(selected)}</span>
          </Caption>
        </div>

        <div>
          <SubsectionTitle>This month</SubsectionTitle>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3" data-testid={id("usage")}>
            <Stat label="Estimated cost" value={formatMicroUsd(month.costMicroUsd)} testId={id("cost")} />
            <Stat label="Requests" value={compactNumber(month.providerCalls)} testId={id("calls")} />
            <Stat label="Failed" value={compactNumber(month.failed)} />
            <Stat label="Served as fallback" value={compactNumber(month.servedAsFallback)} testId={id("as-fallback")} />
            <Stat label="Input tokens" value={compactNumber(month.inputTokens)} />
            <Stat label="Output tokens" value={compactNumber(month.outputTokens)} />
          </dl>
          {month.byModel.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
              {month.byModel.map((m) => (
                <li key={m.model} className="flex flex-wrap justify-between gap-x-3">
                  <span className="[overflow-wrap:anywhere]">{m.model}</span>
                  <span className="tabular-nums">
                    {compactNumber(m.providerCalls)} requests · {m.priced ? formatMicroUsd(m.costMicroUsd) : "no price"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={id("limit")}>Monthly spending limit (US dollars)</Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" aria-hidden="true">
              $
            </span>
            <Input
              id={id("limit")}
              data-testid={id("limit")}
              className="pl-7"
              inputMode="decimal"
              autoComplete="off"
              placeholder="No limit"
              value={draft.limitText}
              disabled={disabled}
              aria-invalid={limitError ? true : undefined}
              aria-describedby={id("limit-help")}
              onChange={(e) => onChange({ limitText: e.target.value })}
            />
          </div>
          {limitError ? (
            <p id={id("limit-help")} role="alert" className="text-xs text-destructive" data-testid={id("limit-error")}>
              {limitError}
            </p>
          ) : (
            <Caption>
              <span id={id("limit-help")}>
                Leave empty for no limit. Once the limit is reached, requests routed to {PROVIDER_LABEL[provider]} are refused until the month ends — they
                are not moved to the other provider.
              </span>
            </Caption>
          )}
          {limit && (
            <div className="space-y-1 pt-1" data-testid={id("limit-status")}>
              <Progress value={Math.min(100, info.limit.usedPct ?? 0)} aria-label={`${PROVIDER_LABEL[provider]} spending against its monthly limit`} />
              <StatusBadge tone={limit.tone}>{limit.label}</StatusBadge>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function OverridesCard({
  status,
  draft,
  disabled,
  onChange,
}: {
  status: PlatformAiProviders;
  draft: PolicyDraft;
  disabled: boolean;
  onChange: (overrides: PolicyDraft["overrides"]) => void;
}) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<{ id: number; name: string } | null>(null);
  const [provider, setProvider] = useState<ProviderName>("anthropic");
  const [model, setModel] = useState(PROVIDER_MODEL);
  const params = useMemo(() => ({ limit: 50, ...(search.trim() ? { search: search.trim() } : {}) }), [search]);
  const companies = useListCompanies(params, { query: { queryKey: getListCompaniesQueryKey(params) } });
  const pinned = new Set(draft.overrides.map((o) => o.companyId));
  const found = (companies.data?.companies ?? []).filter((c) => !pinned.has(c.id));
  // The chosen company stays in the list while the search text changes under it.
  const options = chosen && !pinned.has(chosen.id) && !found.some((c) => c.id === chosen.id) ? [{ id: chosen.id, name: chosen.name }, ...found] : found;
  const models = providerStatus(status, provider)?.models ?? [];

  function add() {
    if (!chosen || pinned.has(chosen.id)) return;
    onChange([...draft.overrides, { companyId: chosen.id, companyName: chosen.name, provider, model: model === PROVIDER_MODEL ? null : model }]);
    setChosen(null);
    setModel(PROVIDER_MODEL);
  }

  return (
    <Card data-testid="ai-overrides">
      <CardHeader>
        <CardTitle className="text-lg">Company overrides</CardTitle>
        <CardDescription>
          Every company uses the primary provider. Pin a company to one provider here. A pinned company still falls back to the other provider when
          automatic fallback is on, and never uses a provider that is disabled.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {draft.overrides.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="ai-overrides-empty">
            No company is pinned. All companies follow the primary provider.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">Remove</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.overrides.map((o) => (
                  <TableRow key={o.companyId} data-testid={`ai-override-${o.companyId}`}>
                    <TableCell className="font-medium [overflow-wrap:anywhere]">{o.companyName ?? `Company ${o.companyId}`}</TableCell>
                    <TableCell>
                      {PROVIDER_LABEL[o.provider]}
                      {!draft.providers[o.provider].enabled && <span className="ml-2 text-xs text-muted-foreground">(disabled — the primary applies)</span>}
                    </TableCell>
                    <TableCell className="[overflow-wrap:anywhere]">{o.model ?? "Provider's selected model"}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={disabled}
                        aria-label={`Remove the override for ${o.companyName ?? `company ${o.companyId}`}`}
                        onClick={() => onChange(draft.overrides.filter((x) => x.companyId !== o.companyId))}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1.4fr_1fr_1.2fr_auto] lg:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="ai-override-search">Find a company</Label>
            <Input id="ai-override-search" placeholder="Search by name" value={search} disabled={disabled} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-override-company">Company</Label>
            <Select
              value={chosen ? String(chosen.id) : ""}
              onValueChange={(v) => {
                const c = options.find((o) => String(o.id) === v);
                setChosen(c ? { id: c.id, name: c.name } : null);
              }}
              disabled={disabled || options.length === 0}
            >
              <SelectTrigger id="ai-override-company" data-testid="ai-override-company">
                <SelectValue placeholder={companies.isLoading ? "Loading…" : options.length === 0 ? "No company found" : "Choose a company"} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {options.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-override-provider">Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v as ProviderName);
                setModel(PROVIDER_MODEL);
              }}
              disabled={disabled}
            >
              <SelectTrigger id="ai-override-provider" data-testid="ai-override-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDER_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-override-model">Model</Label>
            <Select value={model} onValueChange={setModel} disabled={disabled}>
              <SelectTrigger id="ai-override-model" data-testid="ai-override-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={PROVIDER_MODEL}>Provider's selected model</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                    {m.simulated ? " (test)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" onClick={add} disabled={disabled || !chosen} data-testid="ai-override-add">
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Pin company
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function AiProvidersSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const queryKey = getGetPlatformAiProvidersQueryKey();
  const query = useGetPlatformAiProviders({ query: { queryKey } });
  const update = useUpdatePlatformAiProviders();
  const status = query.data;

  // The form, and the version of the policy it was filled from. A save is sent with THAT
  // version, so it can never silently overwrite a change someone else made in between.
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [base, setBase] = useState<PlatformAiProviders | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({ limit: {} });
  const [confirm, setConfirm] = useState<{ warnings: string[]; disablesAllAi: boolean; policy: PlatformAiPolicy } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  function load(next: PlatformAiProviders) {
    setDraft(draftFromStatus(next));
    setBase(next);
    setErrors({ limit: {} });
  }

  useEffect(() => {
    if (!status) return;
    if (!base) {
      load(status);
      return;
    }
    // Fresh figures for the same policy: keep the form. A newer policy replaces an
    // untouched form; a form with edits is kept, and the page says the policy moved on.
    if (status.version !== base.version && draftRef.current && !isDirty(draftRef.current, base)) load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (!status && query.isError) {
    return (
      <ErrorState
        title="AI provider settings could not be loaded"
        description="Nothing has been changed. Try again."
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  // Still loading, or loaded and the form is being filled from it (one render later).
  if (!status || !draft || !base) return <CardGridSkeleton cards={2} className="lg:grid-cols-2" />;

  const readOnly = status.storage === "unavailable";
  const busy = update.isPending;
  const dirty = isDirty(draft, base);
  const stale = status.version !== base.version;
  const serving = servingSummary(status);

  const patch = (next: Partial<PolicyDraft>) => setDraft({ ...draft, ...next });
  const patchProvider = (p: ProviderName, next: Partial<ProviderDraft>) => {
    setDraft({ ...draft, providers: { ...draft.providers, [p]: { ...draft.providers[p], ...next } } });
    if (next.limitText !== undefined && errors.limit[p]) setErrors({ ...errors, limit: { ...errors.limit, [p]: undefined } });
  };

  function send(policy: PlatformAiPolicy, confirmed: boolean) {
    if (!base) return;
    update.mutate(
      { data: { policy, expectedVersion: base.version, ...(confirmed ? { confirm: true } : {}) } },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData(queryKey, saved);
          load(saved);
          setConfirm(null);
          toast({ title: "AI provider settings saved", description: servingSummary(saved).detail });
        },
        onError: (err) => {
          const failure = describeSaveFailure(err);
          if (failure.kind === "confirm") {
            setConfirm({ warnings: failure.warnings, disablesAllAi: failure.disablesAllAi, policy });
            return;
          }
          setConfirm(null);
          if (failure.kind === "conflict") void query.refetch();
          toast({
            variant: "destructive",
            title: failure.kind === "conflict" ? "These settings were changed by someone else" : "The settings were not saved",
            description: failure.kind === "conflict" ? "Nothing was saved. Reload the current settings and apply your change again." : failure.message,
          });
        },
      },
    );
  }

  function save() {
    if (!draft) return;
    const next = draftToPolicy(draft);
    if (!next.ok) {
      setErrors(next.errors);
      return;
    }
    setErrors({ limit: {} });
    send(next.policy, false);
  }

  const changed = status.updatedAt
    ? `Last changed ${new Date(status.updatedAt).toLocaleString()}${status.updatedByName ? ` by ${status.updatedByName}` : ""}.`
    : "Nothing has been saved yet: the default settings are in effect.";

  return (
    <section aria-labelledby="ai-providers-title" className="space-y-6" data-testid="ai-providers-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionTitle>
            <span id="ai-providers-title">AI Providers</span>
          </SectionTitle>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Choose which AI providers serve every company on the platform, which one is preferred and what happens when it cannot answer. Changes apply
            at once and need no deployment.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching} data-testid="ai-refresh">
          <RefreshCw className={cn("mr-1.5 h-4 w-4", query.isFetching && "animate-spin")} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {readOnly && (
        <div role="alert" className={cn("flex gap-3 rounded-lg border p-4", TONE_SURFACE.warning)} data-testid="ai-storage-unavailable">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-foreground">These settings cannot be changed yet</p>
            <p className="mt-1 text-muted-foreground">
              This database does not have the platform settings storage. The default settings shown below are in effect; they can be changed once the
              reviewed schema change has been applied.
            </p>
          </div>
        </div>
      )}

      {query.isError && (
        <div role="alert" className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4", TONE_SURFACE.warning)} data-testid="ai-refresh-failed">
          <p className="min-w-0 text-sm text-foreground">The latest figures could not be loaded. What is shown may be out of date; your edits are kept.</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {stale && (
        <div role="alert" className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4", TONE_SURFACE.warning)} data-testid="ai-stale">
          <p className="min-w-0 text-sm text-foreground">These settings were changed by someone else while you were editing. Your unsaved changes cannot be saved over them.</p>
          <Button variant="outline" size="sm" onClick={() => load(status)}>
            Load the current settings
          </Button>
        </div>
      )}

      <div className={cn("rounded-lg border p-4", TONE_SURFACE[serving.tone])} data-testid="ai-serving-summary">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={serving.tone}>{serving.title}</StatusBadge>
        </div>
        <p className="mt-2 text-sm text-foreground [overflow-wrap:anywhere]">{serving.detail}</p>
        {status.effective.notes.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground" data-testid="ai-serving-notes">
            {status.effective.notes.map((n) => (
              <li key={n} className="flex gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="[overflow-wrap:anywhere]">{n}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground" data-testid="ai-policy-meta">
          {changed}
        </p>
      </div>

      <Card data-testid="ai-routing">
        <CardHeader>
          <CardTitle className="text-lg">Routing</CardTitle>
          <CardDescription>The primary provider serves every company that has no override.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <fieldset className="space-y-2" disabled={readOnly || busy}>
            <legend className="text-sm font-medium text-foreground">Primary provider</legend>
            <RadioGroup
              value={draft.primary}
              onValueChange={(v) => patch({ primary: v as ProviderName })}
              className="grid gap-3 sm:grid-cols-2"
              aria-label="Primary provider"
            >
              {PROVIDERS.map((p) => {
                const info = providerStatus(status, p);
                const hint = !draft.providers[p].enabled ? "Disabled" : usesTestModel(info) ? "Test model" : info && !info.credentials.configured ? "No key on the server" : PROVIDER_VENDOR[p];
                return (
                  <Label
                    key={p}
                    htmlFor={`ai-primary-${p}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal",
                      draft.primary === p ? "border-primary bg-primary-soft" : "border-border",
                    )}
                  >
                    <RadioGroupItem id={`ai-primary-${p}`} value={p} data-testid={`ai-primary-${p}`} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{PROVIDER_LABEL[p]}</span>
                      <span className="block text-xs text-muted-foreground">{hint}</span>
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
          </fieldset>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <Label htmlFor="ai-fallback" className="text-sm font-medium">
                Automatic fallback
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                When the provider in use cannot answer — an outage, overload, rate limit, timeout or a rejected key — the other enabled provider is
                tried once. A company's AI budget, its plan allowance, a spending limit, a disabled feature and a provider's refusal of the content are
                never retried on the other provider.
              </p>
            </div>
            <Switch
              id="ai-fallback"
              data-testid="ai-fallback"
              checked={draft.fallbackEnabled}
              disabled={readOnly || busy}
              onCheckedChange={(fallbackEnabled) => patch({ fallbackEnabled })}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        {PROVIDERS.map((p) => {
          const info = providerStatus(status, p);
          if (!info) return null;
          return (
            <ProviderCard
              key={p}
              provider={p}
              status={status}
              info={info}
              draft={draft.providers[p]}
              limitError={errors.limit[p]}
              disabled={readOnly || busy}
              onChange={(next) => patchProvider(p, next)}
            />
          );
        })}
      </div>

      <Card data-testid="ai-alerts">
        <CardHeader>
          <CardTitle className="text-lg">Spending alerts</CardTitle>
          <CardDescription>
            Platform owners are notified when a provider's spend this month reaches this share of its limit, and again when the limit is reached.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="ai-alert-threshold">Alert at (% of the monthly limit)</Label>
            <Input
              id="ai-alert-threshold"
              data-testid="ai-alert-threshold"
              inputMode="numeric"
              autoComplete="off"
              value={draft.alertText}
              disabled={readOnly || busy}
              aria-invalid={errors.alert ? true : undefined}
              onChange={(e) => {
                patch({ alertText: e.target.value });
                if (errors.alert) setErrors({ ...errors, alert: undefined });
              }}
            />
            {errors.alert && (
              <p role="alert" className="text-xs text-destructive" data-testid="ai-alert-error">
                {errors.alert}
              </p>
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground" data-testid="ai-period">
            Figures cover {serverDate(status.period.from)} to today and are estimates from token usage (price table {status.pricingVersion}). Limits reset
            on {serverDate(status.period.resetAt)}.
          </p>
        </CardContent>
      </Card>

      <OverridesCard status={status} draft={draft} disabled={readOnly || busy} onChange={(overrides) => patch({ overrides })} />

      <div
        className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6"
        data-testid="ai-save-bar"
      >
        <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="ai-dirty-state">
          {readOnly ? "Read-only" : dirty ? "You have unsaved changes." : "All changes are saved."}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => load(status)} disabled={!dirty || busy} data-testid="ai-discard">
            Discard
          </Button>
          <Button onClick={save} disabled={readOnly || !dirty || busy || stale} data-testid="ai-save">
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <AlertDialogContent data-testid="ai-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.disablesAllAi ? "Turn AI off for every company?" : "Confirm this change"}</AlertDialogTitle>
            <AlertDialogDescription>This change affects which AI provider answers requests. It applies to every company at once.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-2 pl-5 text-sm text-foreground" data-testid="ai-confirm-warnings">
            {confirm?.warnings.map((w) => (
              <li key={w} className="[overflow-wrap:anywhere]">
                {w}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} data-testid="ai-confirm-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              data-testid="ai-confirm-apply"
              className={confirm?.disablesAllAi ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={(e) => {
                e.preventDefault();
                if (confirm) send(confirm.policy, true);
              }}
            >
              {busy ? "Applying…" : "Apply change"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
