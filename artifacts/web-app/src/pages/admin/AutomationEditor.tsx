import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetWorkflowCatalog,
  getGetWorkflowCatalogQueryKey,
  useGetWorkflowDefinition,
  getGetWorkflowDefinitionQueryKey,
  getListWorkflowDefinitionsQueryKey,
  getWorkflowDefinition,
  useCreateWorkflowDefinition,
  useUpdateWorkflowDefinition,
  useValidateWorkflowDefinition,
  usePublishWorkflowDefinition,
  useUnpublishWorkflowDefinition,
  useArchiveWorkflowDefinition,
  useDeleteWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
  type WorkflowDefinitionUpdate,
  type WorkflowValidateInput,
} from "@workspace/api-client-react";
import { PageHeader, ErrorState, ListSkeleton } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, ChevronDown, History, Info, Lock, Save, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  asCatalog,
  editorStateFromDefinition,
  emptyEditorState,
  fingerprint,
  issueMap,
  parseApiError,
  toPayload,
  triggerOf,
  actionOf,
  type Catalog,
  type EditorState,
  type IssueMap,
  type ServerIssue,
} from "@/components/automations/catalog";
import { DefinitionStatusBadge, definitionStatusLabel, formatDateTime, formatRelative } from "@/components/automations/format";
import { useWorkflowPermissions } from "@/components/automations/permissions";
import { EntityOptionsProvider } from "@/components/automations/entity-options";
import { FieldShell } from "@/components/automations/builder/FieldShell";
import { TriggerSection } from "@/components/automations/builder/TriggerSection";
import { ConditionsSection } from "@/components/automations/builder/ConditionsSection";
import { ActionsSection } from "@/components/automations/builder/ActionsSection";
import { schemaDefaults } from "@/components/automations/builder/ConfigFields";
import { UnsavedChangesDialog, useUnsavedChangesGuard } from "@/components/automations/useUnsavedChanges";
import { LIFECYCLE_COPY, type LifecycleVerb } from "@/components/automations/lifecycle-copy";

interface Summary {
  tone: "success" | "warning" | "destructive" | "info";
  title: string;
  description?: string;
  issues?: ServerIssue[];
}

const SUMMARY_STYLE: Record<Summary["tone"], string> = {
  success: "border-success/40 bg-success-soft text-foreground",
  warning: "border-warning/40 bg-warning-soft text-foreground",
  destructive: "border-destructive/40 bg-destructive-soft text-foreground",
  info: "border-info/40 bg-info-soft text-foreground",
};

/** Human label for an issue path such as actions[1].config.assignee.userId. */
function describeIssuePath(path: string, state: EditorState | null, catalog: Catalog | undefined): string {
  if (path === "(body)") return "Definition";
  if (path === "name") return "Name";
  if (path === "description") return "Description";
  const action = /^actions\[(\d+)\](?:\.config\.(.+)|\.type)?$/.exec(path);
  if (action) {
    const i = Number(action[1]);
    const label = actionOf(catalog ?? ({ actions: [] } as unknown as Catalog), state?.actions[i]?.type)?.label ?? `Action ${i + 1}`;
    return action[2] ? `Action ${i + 1} (${label}) → ${action[2]}` : `Action ${i + 1} (${label})`;
  }
  if (path === "actions") return "Actions";
  const cond = /^conditions\[(\d+)\](?:\.(.+))?$/.exec(path);
  if (cond) return cond[2] ? `Condition ${Number(cond[1]) + 1} → ${cond[2]}` : `Condition ${Number(cond[1]) + 1}`;
  if (path === "conditions") return "Conditions";
  if (path.startsWith("trigger.config.")) return `Trigger → ${path.slice("trigger.config.".length)}`;
  if (path.startsWith("trigger")) return "Trigger";
  return path;
}

export default function AdminAutomationEditor() {
  const params = useParams<{ id?: string }>();
  const isNew = params.id === undefined;
  const id = isNew ? null : Number(params.id);
  const invalidId = !isNew && (!Number.isInteger(id) || (id as number) <= 0);
  const [, navigate] = useLocation();
  const { canView, canManage } = useWorkflowPermissions();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const catalogQuery = useGetWorkflowCatalog({ query: { queryKey: getGetWorkflowCatalogQueryKey(), enabled: canView, staleTime: 5 * 60_000 } });
  const catalog = useMemo(() => (catalogQuery.data ? asCatalog(catalogQuery.data) : undefined), [catalogQuery.data]);
  const definitionQuery = useGetWorkflowDefinition(id ?? 0, {
    query: { queryKey: getGetWorkflowDefinitionQueryKey(id ?? 0), enabled: canView && !isNew && !invalidId, refetchOnWindowFocus: false },
  });

  const [state, setState] = useState<EditorState | null>(null);
  const [loaded, setLoaded] = useState<WorkflowDefinition | null>(null);
  const [baseline, setBaseline] = useState("");
  const [issues, setIssues] = useState<IssueMap>({});
  const [summary, setSummary] = useState<Summary | null>(null);
  const [conflict, setConflict] = useState<{ currentRevision: number | null } | null>(null);
  const [confirmVerb, setConfirmVerb] = useState<LifecycleVerb | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const announce = useCallback((message: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 30);
  }, []);

  const applyDefinition = useCallback(
    (d: WorkflowDefinition, cat: Catalog) => {
      const s = editorStateFromDefinition(d);
      setLoaded(d);
      setState(s);
      setBaseline(fingerprint(s, cat));
      queryClient.setQueryData(getGetWorkflowDefinitionQueryKey(d.id), d);
    },
    [queryClient],
  );

  // Initial load: a fresh draft for /new, otherwise the stored definition (once).
  useEffect(() => {
    if (!catalog || state) return;
    if (isNew) {
      const s = emptyEditorState(catalog);
      const first = triggerOf(catalog, s.triggerType);
      if (first) s.triggerConfig = schemaDefaults(first.configSchema);
      setState(s);
      setBaseline(fingerprint(s, catalog));
      return;
    }
    if (definitionQuery.data) applyDefinition(definitionQuery.data, catalog);
  }, [catalog, state, isNew, definitionQuery.data, applyDefinition]);

  const status = loaded?.status ?? "draft";
  const lifecycle = catalog?.lifecycle?.[status];
  const editable = lifecycle?.editable ?? status === "draft";
  const transitions = lifecycle?.transitions ?? (status === "draft" ? ["published", "archived"] : status === "published" ? ["draft", "archived"] : []);
  const deletable = lifecycle?.deletable ?? status === "draft";
  const readOnly = !canManage || !editable;
  const dirty = !!state && !!catalog && fingerprint(state, catalog) !== baseline;
  const guard = useUnsavedChangesGuard(dirty && canManage && !readOnly);

  const invalidateLists = () => {
    queryClient.invalidateQueries({ queryKey: getListWorkflowDefinitionsQueryKey() });
  };

  const create = useCreateWorkflowDefinition();
  const update = useUpdateWorkflowDefinition();
  const validate = useValidateWorkflowDefinition();
  const publish = usePublishWorkflowDefinition();
  const unpublish = useUnpublishWorkflowDefinition();
  const archive = useArchiveWorkflowDefinition();
  const remove = useDeleteWorkflowDefinition();
  const busy = create.isPending || update.isPending || validate.isPending || publish.isPending || unpublish.isPending || archive.isPending || remove.isPending;

  const showIssues = (title: string, list: ServerIssue[], tone: Summary["tone"] = "destructive") => {
    setIssues(issueMap(list));
    setSummary({ tone, title, issues: list });
    announce(`${title}. ${list.length} ${list.length === 1 ? "issue" : "issues"} to fix.`);
    window.setTimeout(() => summaryRef.current?.focus(), 50);
  };

  const handleError = (err: unknown, verb: string) => {
    const p = parseApiError(err, `Could not ${verb} the automation`);
    if (p.status === 400 && p.issues.length > 0) {
      showIssues(p.message, p.issues);
      return;
    }
    if (p.status === 409 && p.code === "WORKFLOW_REVISION_CONFLICT") {
      const cur = p.context.currentRevision;
      setConflict({ currentRevision: typeof cur === "number" ? cur : null });
      return;
    }
    if (p.status === 409 && p.code === "WORKFLOW_NAME_TAKEN") {
      showIssues(p.message, [{ field: "name", message: p.message, code: p.code }]);
      return;
    }
    if (p.status === 409) {
      // Read-only / invalid transition / not deletable: the definition moved on elsewhere.
      setSummary({ tone: "warning", title: p.message, description: "Reload the automation to see its current state." });
      announce(p.message);
      return;
    }
    toast({ title: `Could not ${verb} the automation`, description: p.message, variant: "destructive" });
  };

  const buildPayload = () => (state && catalog ? toPayload(state, catalog) : null);

  const save = async (revisionOverride?: number) => {
    const payload = buildPayload();
    if (!payload || !state || !catalog) return;
    if (!payload.name) {
      showIssues("Please fix the highlighted fields", [{ field: "name", message: "Name is required", code: "REQUIRED" }]);
      nameRef.current?.focus();
      return;
    }
    setIssues({});
    setSummary(null);
    try {
      if (isNew) {
        const created = await create.mutateAsync({ data: payload as unknown as WorkflowDefinitionInput });
        applyDefinition(created, catalog);
        invalidateLists();
        toast({ title: "Draft created", description: "The automation is saved as an inactive draft." });
        navigate(`/admin/automations/${created.id}`, { replace: true });
      } else {
        const revision = revisionOverride ?? loaded?.revision;
        if (revision == null) return;
        const body = { revision, ...payload } as unknown as WorkflowDefinitionUpdate;
        const updated = await update.mutateAsync({ id: id as number, data: body });
        applyDefinition(updated, catalog);
        invalidateLists();
        toast({ title: "Changes saved", description: `Revision ${updated.revision}` });
        announce("Changes saved");
      }
    } catch (err) {
      handleError(err, "save");
    }
  };

  const runValidate = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setIssues({});
    setSummary(null);
    try {
      const result = await validate.mutateAsync({ data: { ...payload, name: payload.name || undefined } as unknown as WorkflowValidateInput });
      if (result.valid && result.publishable) {
        setSummary({ tone: "success", title: "Valid — this automation can be published", description: isNew || dirty ? "Save it, then publish to activate it." : "Publish to activate it for future matching CRM events." });
        announce("Validation passed");
      } else if (result.valid) {
        setSummary({ tone: "warning", title: "Valid, but not publishable yet", description: "Add at least one action before publishing." });
        announce("Validation passed, but at least one action is required to publish");
      } else {
        showIssues("Validation found problems", result.errors);
      }
    } catch (err) {
      handleError(err, "validate");
    }
  };

  const runLifecycle = async (verb: LifecycleVerb) => {
    if (!loaded || !catalog) return;
    const vars = { id: loaded.id, data: { revision: loaded.revision } };
    setIssues({});
    setSummary(null);
    try {
      if (verb === "delete") {
        await remove.mutateAsync(vars);
        invalidateLists();
        queryClient.removeQueries({ queryKey: getGetWorkflowDefinitionQueryKey(loaded.id) });
        toast({ title: LIFECYCLE_COPY.delete.success });
        setBaseline(state ? fingerprint(state, catalog) : "");
        navigate("/admin/automations", { replace: true });
        return;
      }
      const result = verb === "publish" ? await publish.mutateAsync(vars) : verb === "unpublish" ? await unpublish.mutateAsync(vars) : await archive.mutateAsync(vars);
      applyDefinition(result, catalog);
      invalidateLists();
      toast({ title: LIFECYCLE_COPY[verb].success });
      announce(LIFECYCLE_COPY[verb].success);
    } catch (err) {
      handleError(err, verb);
    } finally {
      setConfirmVerb(null);
    }
  };

  const reloadLatest = async () => {
    if (!catalog || id == null) return;
    setConflict(null);
    try {
      const fresh = await getWorkflowDefinition(id);
      applyDefinition(fresh, catalog);
      setIssues({});
      setSummary({ tone: "info", title: `Reloaded revision ${fresh.revision}`, description: "Your unsaved changes were discarded." });
      announce(`Reloaded revision ${fresh.revision}`);
    } catch (err) {
      handleError(err, "reload");
    }
  };

  const overwriteWithMine = async () => {
    if (!catalog || id == null) return;
    setConflict(null);
    try {
      const fresh = await getWorkflowDefinition(id);
      if (fresh.status !== "draft") {
        setLoaded(fresh);
        setSummary({ tone: "warning", title: `This automation is now ${definitionStatusLabel(fresh.status, catalog).toLowerCase()}`, description: "It is read-only, so your changes cannot be saved." });
        return;
      }
      await save(fresh.revision);
    } catch (err) {
      handleError(err, "save");
    }
  };

  const onTriggerTypeChange = (type: string) => {
    if (!state || !catalog) return;
    const next = triggerOf(catalog, type);
    const prevEntity = triggerOf(catalog, state.triggerType)?.entity;
    const nextEntity = next?.entity;
    let conditions = state.conditions;
    let actions = state.actions;
    if (nextEntity && nextEntity !== prevEntity) {
      const kept = actions.filter((a) => actionOf(catalog, a.type)?.entities.includes(nextEntity));
      const droppedActions = actions.length - kept.length;
      const droppedConditions = conditions.length;
      conditions = [];
      actions = kept;
      if (droppedActions > 0 || droppedConditions > 0) {
        toast({ title: `Trigger now applies to ${nextEntity}s`, description: `${droppedConditions} condition(s) and ${droppedActions} incompatible action(s) were removed.` });
      }
    }
    setState({ ...state, triggerType: type, triggerConfig: next ? schemaDefaults(next.configSchema) : {}, conditions, actions });
  };

  // ── render guards ───────────────────────────────────────────────────────

  if (!canView) {
    return (
      <div data-testid="automations-forbidden">
        <PageHeader title="Automations" breadcrumbs={[{ label: "Automations", href: "/admin/automations" }, { label: "Automation" }]} />
        <ErrorState title="You do not have access to automations" description="Ask a company administrator for the Workflows permission." />
      </div>
    );
  }
  if (isNew && !canManage) {
    return (
      <div data-testid="automations-forbidden">
        <PageHeader title="New automation" breadcrumbs={[{ label: "Automations", href: "/admin/automations" }, { label: "New automation" }]} />
        <ErrorState title="View-only access" description="You can view automations and their run history, but creating or editing them requires the manage permission." action={<Button asChild variant="outline"><Link href="/admin/automations">Back to automations</Link></Button>} />
      </div>
    );
  }
  if (invalidId || (definitionQuery.isError && parseApiError(definitionQuery.error).status === 404)) {
    return (
      <div>
        <PageHeader title="Automation not found" breadcrumbs={[{ label: "Automations", href: "/admin/automations" }, { label: "Not found" }]} />
        <ErrorState title="Automation not found" description="It may have been deleted, or the link is wrong." action={<Button asChild variant="outline"><Link href="/admin/automations">Back to automations</Link></Button>} />
      </div>
    );
  }
  if (catalogQuery.isError || definitionQuery.isError) {
    const err = catalogQuery.isError ? catalogQuery.error : definitionQuery.error;
    return (
      <div>
        <PageHeader title="Automation" breadcrumbs={[{ label: "Automations", href: "/admin/automations" }, { label: "Automation" }]} />
        <ErrorState
          title="Could not load the automation"
          description={parseApiError(err, "Please try again.").message}
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                catalogQuery.refetch();
                definitionQuery.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }
  if (!catalog || !state) {
    return (
      <div>
        <PageHeader title={isNew ? "New automation" : "Automation"} breadcrumbs={[{ label: "Automations", href: "/admin/automations" }, { label: isNew ? "New automation" : "Loading…" }]} />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  const trigger = triggerOf(catalog, state.triggerType);
  const entity = trigger?.entity;
  const title = isNew ? "New automation" : loaded?.name ?? "Automation";
  const canPublish = !isNew && !dirty && transitions.includes("published");
  const runsHref = loaded ? `/admin/automations?tab=runs&definition=${loaded.id}` : "/admin/automations?tab=runs";

  const bannerReason = !canManage ? "view-only" : !editable ? status : null;

  return (
    <EntityOptionsProvider enabled={canView}>
      <div className="min-w-0" data-testid="automation-editor" data-status={status} data-dirty={dirty ? "true" : "false"}>
        <div className="sr-only" role="status" aria-live="polite" data-testid="editor-announcer">
          {announcement}
        </div>

        <PageHeader
          title={title}
          breadcrumbs={[{ label: "Automations", href: "/admin/automations" }, { label: isNew ? "New automation" : loaded?.name ?? "Automation" }]}
          description={isNew ? "Drafts are inactive until you publish them." : `Revision ${loaded?.revision ?? "—"} · updated ${formatRelative(loaded?.updatedAt)}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {loaded && <DefinitionStatusBadge status={status} catalog={catalog} className="me-1" />}
              {!isNew && (
                <Button asChild variant="outline" size="sm">
                  <Link href={runsHref} data-testid="button-view-runs">
                    <History className="me-2 h-4 w-4" aria-hidden="true" /> View runs
                  </Link>
                </Button>
              )}
              {canManage && editable && (
                <>
                  <Button type="button" variant="outline" size="sm" onClick={runValidate} disabled={busy} data-testid="button-validate">
                    <ShieldCheck className="me-2 h-4 w-4" aria-hidden="true" /> Validate
                  </Button>
                  <Button type="button" size="sm" onClick={() => save()} disabled={busy || (!isNew && !dirty)} data-testid="button-save">
                    <Save className="me-2 h-4 w-4" aria-hidden="true" /> {isNew ? "Create draft" : dirty ? "Save changes" : "Saved"}
                  </Button>
                </>
              )}
              {canManage && !isNew && transitions.includes("published") && (
                <Button type="button" size="sm" variant={dirty ? "outline" : "default"} onClick={() => setConfirmVerb("publish")} disabled={busy || !canPublish} title={dirty ? "Save your changes before publishing" : undefined} data-testid="button-publish">
                  Publish
                </Button>
              )}
              {canManage && !isNew && transitions.includes("draft") && (
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmVerb("unpublish")} disabled={busy} data-testid="button-unpublish">
                  Unpublish
                </Button>
              )}
              {canManage && !isNew && (transitions.includes("archived") || deletable) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" size="sm" variant="outline" disabled={busy} aria-label="More actions" data-testid="button-more">
                      More <ChevronDown className="ms-1 h-4 w-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {transitions.includes("archived") && (
                      <DropdownMenuItem onSelect={() => setConfirmVerb("archive")} data-testid="button-archive">
                        Archive
                      </DropdownMenuItem>
                    )}
                    {deletable && (
                      <>
                        {transitions.includes("archived") && <DropdownMenuSeparator />}
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirmVerb("delete")} data-testid="button-delete">
                          Delete draft
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => guard.requestNavigation("/admin/automations")} data-testid="button-back">
                {dirty && canManage && editable ? "Cancel" : "Back"}
              </Button>
            </div>
          }
        />

        {bannerReason && (
          <Alert className="mb-4" data-testid="readonly-banner" data-reason={bannerReason}>
            <Lock className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>
              {bannerReason === "view-only" ? "View-only access" : bannerReason === "published" ? "Active and read-only" : bannerReason === "archived" ? "Archived — read-only history" : "Read-only"}
            </AlertTitle>
            <AlertDescription>
              {bannerReason === "view-only"
                ? "You can review this automation and its run history. Editing and lifecycle changes require the manage permission."
                : bannerReason === "published"
                  ? "This automation executes for every future matching CRM event. Unpublish it to make changes; executions already queued or running finish from their captured snapshots."
                  : bannerReason === "archived"
                    ? "This automation is inactive and kept as terminal history. It cannot be edited or reactivated."
                    : lifecycle?.description}
            </AlertDescription>
          </Alert>
        )}

        {summary && (
          <div ref={summaryRef} tabIndex={-1} role={summary.tone === "destructive" ? "alert" : "status"} data-testid="validation-summary" data-tone={summary.tone} className={cn("mb-4 rounded-lg border p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring", SUMMARY_STYLE[summary.tone])}>
            <div className="flex items-start gap-2">
              {summary.tone === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" aria-hidden="true" /> : summary.tone === "info" ? <Info className="mt-0.5 h-4 w-4 text-info" aria-hidden="true" /> : <AlertTriangle className={cn("mt-0.5 h-4 w-4", summary.tone === "warning" ? "text-warning" : "text-destructive")} aria-hidden="true" />}
              <div className="min-w-0">
                <p className="text-sm font-semibold">{summary.title}</p>
                {summary.description && <p className="mt-0.5 text-sm text-muted-foreground">{summary.description}</p>}
                {summary.issues && summary.issues.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 ps-5 text-sm" data-testid="validation-issues">
                    {summary.issues.map((i, idx) => (
                      <li key={`${i.field}-${idx}`}>
                        <span className="font-medium">{describeIssuePath(i.field, state, catalog)}:</span> {i.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-6">
            <Card className="rounded-xl border-border shadow-sm" data-testid="section-details">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-semibold">Details</CardTitle>
                <CardDescription>Name this automation so your team recognises it in the list and in run history.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <FieldShell id="automation-name" path="name" label="Name" required error={issues["name"]} hint={`${state.name.length}/${catalog.limits.nameMaxLength} characters`}>
                  <Input
                    id="automation-name"
                    ref={nameRef}
                    data-testid="automation-name"
                    value={state.name}
                    maxLength={catalog.limits.nameMaxLength}
                    disabled={readOnly}
                    aria-invalid={!!issues["name"] || undefined}
                    aria-describedby={issues["name"] ? "automation-name-error" : undefined}
                    className={cn(issues["name"] && "border-destructive")}
                    placeholder="e.g. Assign new website leads to Sales"
                    onChange={(e) => setState({ ...state, name: e.target.value })}
                  />
                </FieldShell>
                <FieldShell id="automation-description" path="description" label="Description" error={issues["description"]} hint="Optional. Explain what this automation does and why.">
                  <Textarea
                    id="automation-description"
                    data-testid="automation-description"
                    value={state.description}
                    maxLength={catalog.limits.descriptionMaxLength}
                    disabled={readOnly}
                    rows={2}
                    onChange={(e) => setState({ ...state, description: e.target.value })}
                  />
                </FieldShell>
              </CardContent>
            </Card>

            <TriggerSection catalog={catalog} triggerType={state.triggerType} config={state.triggerConfig} onTypeChange={onTriggerTypeChange} onConfigChange={(cfg) => setState({ ...state, triggerConfig: cfg })} errors={issues} disabled={readOnly} />
            <ConditionsSection catalog={catalog} entity={entity} conditions={state.conditions} onChange={(c) => setState({ ...state, conditions: c })} errors={issues} disabled={readOnly} />
            <ActionsSection catalog={catalog} entity={entity} actions={state.actions} onChange={(a) => setState({ ...state, actions: a })} errors={issues} disabled={readOnly} announce={announce} />

            {canManage && editable && (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
                <Button type="button" variant="outline" onClick={runValidate} disabled={busy}>
                  Validate
                </Button>
                <Button type="button" onClick={() => save()} disabled={busy || (!isNew && !dirty)} data-testid="button-save-bottom">
                  {isNew ? "Create draft" : dirty ? "Save changes" : "Saved"}
                </Button>
              </div>
            )}
          </div>

          <aside className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start" aria-label="Automation status">
            <Card className="rounded-xl border-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Current</span>
                  <DefinitionStatusBadge status={status} catalog={catalog} />
                </div>
                <p className="text-xs text-muted-foreground">{lifecycle?.description}</p>
                {loaded && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Revision</dt>
                    <dd className="tabular-nums" data-testid="automation-revision">
                      {loaded.revision}
                    </dd>
                    <dt className="text-muted-foreground">Created</dt>
                    <dd>{formatDateTime(loaded.createdAt)}</dd>
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd>{formatDateTime(loaded.updatedAt)}</dd>
                    {loaded.archivedAt && (
                      <>
                        <dt className="text-muted-foreground">Archived</dt>
                        <dd>{formatDateTime(loaded.archivedAt)}</dd>
                      </>
                    )}
                  </dl>
                )}
                {dirty && canManage && editable && (
                  <p className="rounded-md bg-warning-soft px-2 py-1 text-xs text-foreground" data-testid="unsaved-indicator">
                    Unsaved changes
                  </p>
                )}
              </CardContent>
            </Card>
            <Card className="rounded-xl border-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">How it works</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Draft</span> — inactive and editable. Nothing runs.
                </p>
                <p>
                  <span className="font-medium text-foreground">Active</span> — published; executes on every future matching CRM event and is read-only.
                </p>
                <p>
                  <span className="font-medium text-foreground">Archived</span> — inactive, terminal history.
                </p>
                <p>Up to {catalog.limits.maxConditions} conditions and {catalog.limits.maxActions} actions per automation. Actions never send AI-generated content and never run without a matching event.</p>
              </CardContent>
            </Card>
          </aside>
        </div>

        <UnsavedChangesDialog open={guard.pendingHref !== null} onCancel={guard.cancel} onDiscard={guard.confirm} />

        <AlertDialog open={!!confirmVerb} onOpenChange={(o) => !o && !busy && setConfirmVerb(null)}>
          <AlertDialogContent data-testid="lifecycle-dialog">
            {confirmVerb && (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>{LIFECYCLE_COPY[confirmVerb].title}</AlertDialogTitle>
                  <AlertDialogDescription>
                    <span className="block font-medium text-foreground">{loaded?.name}</span>
                    {LIFECYCLE_COPY[confirmVerb].description}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy} data-testid="lifecycle-cancel">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    data-testid={`confirm-${confirmVerb}`}
                    disabled={busy}
                    className={LIFECYCLE_COPY[confirmVerb].destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      void runLifecycle(confirmVerb);
                    }}
                  >
                    {busy ? "Working…" : LIFECYCLE_COPY[confirmVerb].confirm}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            )}
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={!!conflict} onOpenChange={(o) => !o && setConflict(null)}>
          <AlertDialogContent data-testid="conflict-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>This automation was changed by someone else</AlertDialogTitle>
              <AlertDialogDescription>
                You are editing revision {loaded?.revision ?? "—"}
                {conflict?.currentRevision != null ? `, but the server now has revision ${conflict.currentRevision}` : ", but the server has a newer revision"}. Nothing has been overwritten. Reload to see the latest version (your changes are discarded), or overwrite it with your changes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
              <AlertDialogCancel data-testid="conflict-keep">Keep editing</AlertDialogCancel>
              <Button type="button" variant="outline" onClick={() => void reloadLatest()} data-testid="conflict-reload">
                Reload latest
              </Button>
              <AlertDialogAction
                data-testid="conflict-overwrite"
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={(e) => {
                  e.preventDefault();
                  void overwriteWithMine();
                }}
              >
                Overwrite with my changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </EntityOptionsProvider>
  );
}
