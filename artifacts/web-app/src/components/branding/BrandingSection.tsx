import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  customFetch,
  getGetTenantBrandingQueryKey,
  getUploadTenantLogoUrl,
  useUpdateTenantBranding,
  useRemoveTenantLogo,
  useResetTenantBranding,
  ApiError,
  type TenantBranding,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ListSkeleton } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useBranding } from "@/contexts/BrandingContext";
import { useUnsavedChangesGuard, UnsavedChangesDialog } from "@/components/automations/useUnsavedChanges";
import { cn } from "@/lib/utils";
import { contrastRatio, derivePalette, foregroundFor, normalizeHex, type BrandPalette, type BrandTheme } from "@/lib/branding-tokens";
import { Building2, ImageUp, Palette, RotateCcw, Save, Trash2, Undo2, Upload, X, Zap } from "lucide-react";

// =============================================================================
// Batch 18 — Organization → Branding. Colors/theme are a draft saved explicitly
// (with the B17 unsaved-change guard, browser Back/Forward included); the logo
// is uploaded/removed immediately through its own validated endpoints. The live
// preview mirrors the server's derivation so what is shown is what will apply.
// =============================================================================

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const THEME_OPTIONS: Array<{ value: BrandTheme | ""; label: string; hint: string }> = [
  { value: "", label: "Platform default", hint: "Follows the device setting (system)." },
  { value: "light", label: "Light", hint: "New members start in light mode." },
  { value: "dark", label: "Dark", hint: "New members start in dark mode." },
  { value: "system", label: "System", hint: "Follows each member's device setting." },
];

interface Draft {
  primaryColor: string | null; // null = platform default
  sidebarColor: string | null;
  defaultTheme: BrandTheme | null;
}

function draftFrom(b: TenantBranding): Draft {
  return { primaryColor: b.overrides.primaryColor, sidebarColor: b.overrides.sidebarColor, defaultTheme: b.overrides.defaultTheme ?? null };
}

function colorIssue(value: string | null): string | null {
  if (value == null) return null;
  const n = normalizeHex(value);
  if (!n) return "Use a 6-digit hex color such as #1E3A8A.";
  const fg = foregroundFor(n);
  if (fg.ratio < 4.5) return `Text would not be readable on this color (${fg.ratio.toFixed(2)}:1, minimum 4.5:1). Choose a darker or lighter shade.`;
  return null;
}

function errorMessage(err: unknown, fallback: string): { message: string; code: string | null; status: number | null } {
  if (err instanceof ApiError) {
    const data = (err.data ?? {}) as { error?: string; code?: string; details?: { issues?: Array<{ message: string }> } };
    const first = data.details?.issues?.[0]?.message;
    return { message: first ?? data.error ?? fallback, code: data.code ?? null, status: err.status };
  }
  return { message: err instanceof Error && err.message ? err.message : fallback, code: null, status: null };
}

/** A miniature portal (header, sidebar, button, link, focus ring) rendered from a palette. */
function Preview({ palette, mode, logoUrl, companyName, testId }: { palette: BrandPalette; mode: "light" | "dark"; logoUrl: string | null; companyName: string; testId: string }) {
  const dark = mode === "dark";
  const pageBg = dark ? "#1A1A1A" : "#F8F9FB";
  const cardBg = dark ? "#212121" : "#FFFFFF";
  const text = dark ? "#F5F7FA" : "#212121";
  const muted = dark ? "#A3A9B5" : "#6B7280";
  const link = dark ? palette.primaryLinkDark : palette.primaryLinkLight;
  const soft = dark ? palette.primarySoftDark : palette.primarySoftLight;
  return (
    <div className="overflow-hidden rounded-lg border border-border text-[11px] leading-tight" style={{ background: pageBg, color: text }} data-testid={testId} aria-label={`${mode} mode preview`}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ background: palette.sidebar, color: palette.sidebarForeground }} data-testid={`${testId}-header`}>
        {logoUrl ? <img src={logoUrl} alt="" className="h-5 w-5 rounded object-contain bg-white/95 p-px" /> : <span className="flex h-5 w-5 items-center justify-center rounded" style={{ background: palette.primary, color: palette.primaryForeground }}><Zap className="h-3 w-3" aria-hidden="true" /></span>}
        <span className="truncate font-semibold">{companyName}</span>
        <span className="ms-auto h-4 w-16 rounded" style={{ background: palette.sidebarAccent }} aria-hidden="true" />
      </div>
      <div className="flex">
        <div className="w-24 shrink-0 space-y-1 p-2" style={{ background: palette.sidebar, color: palette.sidebarForeground }}>
          <span className="block rounded px-2 py-1 font-medium" style={{ background: palette.primary, color: palette.primaryForeground }} data-testid={`${testId}-nav-active`}>Contacts</span>
          <span className="block rounded px-2 py-1" style={{ color: palette.sidebarForeground, opacity: 0.8 }}>Leads</span>
          <span className="block rounded px-2 py-1" style={{ color: palette.sidebarForeground, opacity: 0.8 }}>Events</span>
        </div>
        <div className="flex-1 space-y-2 p-3">
          <div className="rounded-md border border-border p-2" style={{ background: cardBg }}>
            <p className="font-semibold">Welcome to {companyName}</p>
            <p style={{ color: muted }}>Primary actions, links and focus rings use your brand color.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-md px-2 py-1 font-medium" style={{ background: palette.primary, color: palette.primaryForeground }} data-testid={`${testId}-button`}>Primary button</span>
              <span className="rounded-md px-2 py-1" style={{ background: soft, color: link }}>Soft badge</span>
              <span className="underline" style={{ color: link }} data-testid={`${testId}-link`}>Brand link</span>
              <span className="rounded-md border border-border px-2 py-1" style={{ boxShadow: `0 0 0 2px ${pageBg}, 0 0 0 4px ${link}` }}>Focused</span>
            </div>
          </div>
          <p style={{ color: muted }}>
            Text on primary {palette.primaryContrast.toFixed(1)}:1 · header text {palette.sidebarContrast.toFixed(1)}:1 · link {contrastRatio(link, pageBg).toFixed(1)}:1
          </p>
        </div>
      </div>
    </div>
  );
}

export function BrandingSection() {
  const { user } = useAuth();
  const { branding, isLoading, refetch } = useBranding();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = user?.role === "primary_admin" || ((user?.permissions?.organization as string[] | undefined) ?? []).includes("edit");
  const queryKey = [...getGetTenantBrandingQueryKey(), { userId: user?.id ?? null, companyId: user?.companyId ?? null }];
  const companyName = user?.companyName || "Your company";

  const [draft, setDraft] = useState<Draft | null>(null);
  const [hexInput, setHexInput] = useState<{ primary: string; sidebar: string }>({ primary: "", sidebar: "" });
  const [storageError, setStorageError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"reset" | "remove" | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // (Re)seed the draft whenever the server copy changes and nothing is being edited.
  const serverDraft = branding ? JSON.stringify(draftFrom(branding)) : null;
  useEffect(() => {
    if (!branding) return;
    setDraft((cur) => (cur == null || JSON.stringify(cur) === serverDraft ? draftFrom(branding) : cur));
    setHexInput({ primary: branding.overrides.primaryColor ?? "", sidebar: branding.overrides.sidebarColor ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDraft]);

  const update = useUpdateTenantBranding();
  const remove = useRemoveTenantLogo();
  const reset = useResetTenantBranding();
  const busy = update.isPending || remove.isPending || reset.isPending || logoBusy;

  const commit = (next: TenantBranding, title: string) => {
    queryClient.setQueryData(queryKey, next);
    setDraft(draftFrom(next));
    setHexInput({ primary: next.overrides.primaryColor ?? "", sidebar: next.overrides.sidebarColor ?? "" });
    setStorageError(null);
    toast({ title });
  };

  const dirty = !!branding && !!draft && JSON.stringify(draft) !== serverDraft;
  const guard = useUnsavedChangesGuard(dirty && canEdit);

  const primaryIssue = draft ? colorIssue(draft.primaryColor) : null;
  const sidebarIssue = draft ? colorIssue(draft.sidebarColor) : null;
  const invalid = !!primaryIssue || !!sidebarIssue;

  const palette = useMemo<BrandPalette | null>(() => {
    if (!branding || !draft) return null;
    const primary = (draft.primaryColor && normalizeHex(draft.primaryColor)) || branding.defaults.primaryColor;
    const sidebar = (draft.sidebarColor && normalizeHex(draft.sidebarColor)) || branding.defaults.sidebarColor;
    return derivePalette(primary, sidebar, branding.defaults.primaryColor);
  }, [branding, draft]);

  if (!user || user.role === "platform_owner") return null;

  const setColor = (field: "primary" | "sidebar", raw: string) => {
    setHexInput((h) => ({ ...h, [field]: raw }));
    const key = field === "primary" ? "primaryColor" : "sidebarColor";
    setDraft((d) => (d ? { ...d, [key]: raw.trim() === "" ? null : raw.trim() } : d));
  };
  const useDefault = (field: "primary" | "sidebar") => setColor(field, "");

  const save = () => {
    if (!draft || !branding) return;
    update.mutate(
      { data: { primaryColor: draft.primaryColor ? normalizeHex(draft.primaryColor) : null, sidebarColor: draft.sidebarColor ? normalizeHex(draft.sidebarColor) : null, defaultTheme: draft.defaultTheme } },
      {
        onSuccess: (next) => commit(next, "Branding saved"),
        onError: (err) => {
          const e = errorMessage(err, "Could not save branding");
          toast({ title: e.status === 403 ? "You cannot change branding" : "Could not save branding", description: e.message, variant: "destructive" });
        },
      },
    );
  };

  const cancel = () => {
    if (!branding) return;
    setDraft(draftFrom(branding));
    setHexInput({ primary: branding.overrides.primaryColor ?? "", sidebar: branding.overrides.sidebarColor ?? "" });
  };

  const onFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      toast({ title: "Unsupported file type", description: "Upload a PNG, JPEG or WebP logo.", variant: "destructive" });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast({ title: "Logo too large", description: "The logo must be 2 MB or smaller.", variant: "destructive" });
      return;
    }
    setLogoBusy(true);
    setStorageError(null);
    try {
      const next = await customFetch<TenantBranding>(getUploadTenantLogoUrl(), { method: "POST", body: file, headers: { "Content-Type": file.type }, responseType: "json" });
      commit(next, branding?.overrides.logo ? "Logo replaced" : "Logo uploaded");
    } catch (err) {
      const e = errorMessage(err, "Could not upload the logo");
      if (e.status === 503 || e.code === "BRANDING_STORAGE_UNAVAILABLE") setStorageError(e.message);
      else toast({ title: "Logo rejected", description: e.message, variant: "destructive" });
    } finally {
      setLogoBusy(false);
    }
  };

  const doRemove = () =>
    remove.mutate(undefined, {
      onSuccess: (next) => commit(next, "Logo removed"),
      onError: (err) => {
        const e = errorMessage(err, "Could not remove the logo");
        if (e.status === 503) setStorageError(e.message);
        else toast({ title: "Could not remove the logo", description: e.message, variant: "destructive" });
      },
      onSettled: () => setConfirm(null),
    });

  const doReset = () =>
    reset.mutate(undefined, {
      onSuccess: (next) => commit(next, "Branding reset to the platform default"),
      onError: (err) => toast({ title: "Could not reset branding", description: errorMessage(err, "Please try again").message, variant: "destructive" }),
      onSettled: () => setConfirm(null),
    });

  return (
    <Card className="rounded-xl border-border shadow-sm" data-testid="branding-section" data-dirty={dirty ? "true" : "false"}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden="true">
              <Palette className="h-4 w-4" />
            </span>
            <CardTitle className="text-lg font-semibold">Branding</CardTitle>
          </div>
          {branding?.isCustomized && <span className="text-xs text-muted-foreground" data-testid="branding-customized">Customized</span>}
        </div>
        <CardDescription>Your logo and colors apply to every member's portal and to public digital business cards. Colors and the default theme are saved explicitly; logo changes apply immediately.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading || !branding || !draft || !palette ? (
          <ListSkeleton rows={4} />
        ) : (
          <>
            {!canEdit && (
              <Alert data-testid="branding-readonly">
                <AlertTitle>View only</AlertTitle>
                <AlertDescription>Changing branding requires the organization edit permission.</AlertDescription>
              </Alert>
            )}
            {storageError && (
              <Alert variant="destructive" role="alert" data-testid="branding-storage-error">
                <AlertTitle>Logo storage is unavailable</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  <span>{storageError} Your current branding was not changed.</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => { setStorageError(null); fileRef.current?.click(); }} disabled={!canEdit || busy}>
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {/* Logo */}
            <div className="grid gap-4 md:grid-cols-[auto_1fr] md:items-start">
              <div className="flex h-24 w-40 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 p-2" data-testid="branding-logo-preview" data-logo-source={branding.logoSource}>
                {branding.logoUrl ? (
                  <img src={branding.logoUrl} alt={`${companyName} logo`} className="max-h-20 max-w-full object-contain" data-testid="branding-logo-image" />
                ) : (
                  <span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
                    <Building2 className="h-6 w-6" aria-hidden="true" /> No logo
                  </span>
                )}
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Logo</p>
                <p className="text-xs text-muted-foreground">
                  PNG, JPEG or WebP up to 2 MB, at least 32×32 px. Transparent PNG logos keep their transparency.
                  {branding.logoSource === "legacy" && " This logo comes from a legacy link; upload a file to manage it here."}
                </p>
                <input ref={fileRef} type="file" accept={LOGO_TYPES.join(",")} className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} disabled={!canEdit || busy} data-testid="branding-logo-upload" aria-label="Upload logo file" />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={!canEdit || busy} data-testid="branding-logo-replace">
                    {logoBusy ? <Upload className="me-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ImageUp className="me-2 h-4 w-4" aria-hidden="true" />}
                    {logoBusy ? "Uploading…" : branding.logoUrl ? "Replace logo" : "Upload logo"}
                  </Button>
                  {branding.logoUrl && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm("remove")} disabled={!canEdit || busy} data-testid="branding-logo-remove">
                      <Trash2 className="me-2 h-4 w-4" aria-hidden="true" /> Remove logo
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Colors */}
            <div className="grid gap-4 md:grid-cols-2">
              {(
                [
                  { field: "primary", label: "Primary color", hint: "Buttons, links, focus rings, selected navigation and chart accents.", value: draft.primaryColor, issue: primaryIssue, resolved: palette.primary, defaultValue: branding.defaults.primaryColor },
                  { field: "sidebar", label: "Sidebar / header color", hint: "The top bar and the navigation sidebar.", value: draft.sidebarColor, issue: sidebarIssue, resolved: palette.sidebar, defaultValue: branding.defaults.sidebarColor },
                ] as const
              ).map((c) => {
                const pickerValue = normalizeHex(c.value ?? "") ?? c.resolved;
                return (
                  <div key={c.field} className="space-y-1.5" data-testid={`branding-${c.field}`}>
                    <Label htmlFor={`branding-${c.field}-hex`} className="text-xs font-medium">
                      {c.label}
                    </Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={pickerValue}
                        onChange={(e) => setColor(c.field, e.target.value.toUpperCase())}
                        disabled={!canEdit || busy}
                        aria-label={`${c.label} picker`}
                        className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`branding-${c.field}-picker`}
                      />
                      <Input
                        id={`branding-${c.field}-hex`}
                        value={hexInput[c.field]}
                        placeholder={`${c.defaultValue} (platform default)`}
                        onChange={(e) => setColor(c.field, e.target.value)}
                        disabled={!canEdit || busy}
                        maxLength={7}
                        aria-invalid={!!c.issue || undefined}
                        aria-describedby={c.issue ? `branding-${c.field}-error` : undefined}
                        className={cn("font-mono uppercase", c.issue && "border-destructive")}
                        data-testid={`branding-${c.field}-hex`}
                      />
                      {c.value != null && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => useDefault(c.field)} disabled={!canEdit || busy} aria-label={`Use the platform default ${c.label.toLowerCase()}`} data-testid={`branding-${c.field}-default`}>
                          <X className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                    {c.issue ? (
                      <p id={`branding-${c.field}-error`} role="alert" className="text-xs text-destructive" data-testid={`branding-${c.field}-error`}>
                        {c.issue}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {c.value == null ? `Platform default ${c.defaultValue}. ` : ""}
                        {c.hint}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Default theme */}
            <fieldset className="space-y-2" data-testid="branding-theme">
              <legend className="text-xs font-medium">Default theme</legend>
              <p className="text-xs text-muted-foreground">Members who have not chosen a theme themselves get this one. A member's own light/dark/system choice always wins.</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {THEME_OPTIONS.map((opt) => {
                  const checked = (draft.defaultTheme ?? "") === opt.value;
                  return (
                    <label
                      key={opt.value || "default"}
                      className={cn("flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", checked && "border-primary bg-primary-soft", (!canEdit || busy) && "cursor-not-allowed opacity-60")}
                    >
                      <input
                        type="radio"
                        name="branding-default-theme"
                        value={opt.value}
                        checked={checked}
                        onChange={() => setDraft((d) => (d ? { ...d, defaultTheme: (opt.value || null) as BrandTheme | null } : d))}
                        disabled={!canEdit || busy}
                        className="mt-0.5"
                        data-testid={`branding-theme-${opt.value || "default"}`}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{opt.label}</span>
                        <span className="block text-xs text-muted-foreground">{opt.hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* Live preview */}
            <div className="space-y-2">
              <p className="text-xs font-medium">Live preview</p>
              <div className="grid gap-3 lg:grid-cols-2">
                <Preview palette={palette} mode="light" logoUrl={branding.logoUrl} companyName={companyName} testId="branding-preview-light" />
                <Preview palette={palette} mode="dark" logoUrl={branding.logoUrl} companyName={companyName} testId="branding-preview-dark" />
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm("reset")} disabled={!canEdit || busy || !branding.isCustomized} data-testid="branding-reset">
                <RotateCcw className="me-2 h-4 w-4" aria-hidden="true" /> Reset to platform default
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                {dirty && (
                  <span className="text-xs text-muted-foreground" role="status" data-testid="branding-dirty">
                    Unsaved changes
                  </span>
                )}
                <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={!dirty || busy} data-testid="branding-cancel">
                  <Undo2 className="me-2 h-4 w-4" aria-hidden="true" /> Cancel
                </Button>
                <Button type="button" size="sm" onClick={save} disabled={!canEdit || !dirty || invalid || busy} data-testid="branding-save">
                  <Save className="me-2 h-4 w-4" aria-hidden="true" /> {update.isPending ? "Saving…" : "Save branding"}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>

      <UnsavedChangesDialog open={guard.pending !== null} onCancel={guard.cancel} onDiscard={guard.confirm} />

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent data-testid="branding-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "reset" ? "Reset branding to the platform default?" : "Remove the logo?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "reset"
                ? "Colors, the default theme and the logo return to the platform look for every member and public card. This cannot be undone."
                : "The logo disappears from the portal and public digital cards immediately."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              data-testid={confirm === "reset" ? "branding-confirm-reset" : "branding-confirm-remove"}
              onClick={(e) => {
                e.preventDefault();
                if (confirm === "reset") doReset();
                else doRemove();
              }}
            >
              {confirm === "reset" ? "Reset branding" : "Remove logo"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <span className="sr-only" aria-live="polite">
        {busy ? "Working" : ""}
      </span>
      <span className="hidden" data-testid="branding-refetch" onClick={refetch} />
    </Card>
  );
}
