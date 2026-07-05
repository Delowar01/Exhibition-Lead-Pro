import React, { useState } from "react";
import {
  usePreviewImport,
  useValidateImport,
  useCommitImport,
  type ImportPreviewResult,
  type ImportValidateResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, FileSpreadsheet, AlertTriangle, Copy, CheckCircle2, Loader2, ArrowRight, ArrowLeft } from "lucide-react";

type EntityType = "contact" | "lead";
type Step = "upload" | "map" | "review" | "done";
const SKIP = "__skip__";

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: EntityType;
  /** Called after a successful commit so the parent can refetch its list. */
  onImported?: () => void;
}

export function ImportWizard({ open, onOpenChange, entityType, onImported }: ImportWizardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const preview = usePreviewImport();
  const validate = useValidateImport();
  const commit = useCommitImport();

  const [step, setStep] = useState<Step>("upload");
  const [fileB64, setFileB64] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [previewData, setPreviewData] = useState<ImportPreviewResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [validation, setValidation] = useState<ImportValidateResult | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [committed, setCommitted] = useState<{ imported: number; skippedDuplicates: number; skippedErrors: number } | null>(null);

  const label = entityType === "contact" ? "Contacts" : "Leads";

  const reset = () => {
    setStep("upload");
    setFileB64("");
    setFileName("");
    setPreviewData(null);
    setMapping({});
    setValidation(null);
    setSkipDuplicates(true);
    setCommitted(null);
  };

  const handleClose = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const b64 = await readFileAsBase64(file);
      setFileB64(b64);
      setFileName(file.name);
      preview.mutate(
        { data: { entityType, file: b64 } },
        {
          onSuccess: (res) => {
            setPreviewData(res);
            setMapping({ ...res.inferredMapping });
            setStep("map");
          },
          onError: (err: unknown) => {
            const msg = (err as { detail?: string; message?: string })?.detail ?? (err as Error)?.message ?? "Could not parse the file.";
            toast({ title: "Import failed", description: String(msg), variant: "destructive" });
          },
        },
      );
    } catch {
      toast({ title: "Could not read file", variant: "destructive" });
    }
  };

  const handleValidate = () => {
    validate.mutate(
      { data: { entityType, file: fileB64, mapping } },
      {
        onSuccess: (res) => {
          setValidation(res);
          setStep("review");
        },
        onError: () => toast({ title: "Validation failed", variant: "destructive" }),
      },
    );
  };

  const handleCommit = () => {
    commit.mutate(
      { data: { entityType, file: fileB64, mapping, skipDuplicates } },
      {
        onSuccess: (res) => {
          setCommitted(res);
          setStep("done");
          queryClient.invalidateQueries();
          onImported?.();
          toast({ title: `Imported ${res.imported} ${entityType}${res.imported === 1 ? "" : "s"}` });
        },
        onError: (err: unknown) => {
          const msg = (err as { detail?: string; message?: string })?.detail ?? (err as Error)?.message ?? "Could not import the rows.";
          toast({ title: "Import failed", description: String(msg), variant: "destructive" });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import {label}</DialogTitle>
          <DialogDescription>
            Upload a CSV or Excel file, map its columns, review issues, then import.
          </DialogDescription>
        </DialogHeader>

        <StepIndicator step={step} />

        {step === "upload" && (
          <UploadStep onFile={handleFile} loading={preview.isPending} fileName={fileName} />
        )}

        {step === "map" && previewData && (
          <MapStep
            preview={previewData}
            mapping={mapping}
            onChange={(col, field) => setMapping((m) => ({ ...m, [col]: field }))}
          />
        )}

        {step === "review" && validation && (
          <ReviewStep
            validation={validation}
            entityType={entityType}
            skipDuplicates={skipDuplicates}
            onSkipChange={setSkipDuplicates}
          />
        )}

        {step === "done" && committed && (
          <DoneStep committed={committed} entityType={entityType} />
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {step === "map" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleValidate} disabled={validate.isPending}>
                {validate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Validate <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </>
          )}
          {step === "review" && validation && (
            <>
              <Button variant="outline" onClick={() => setStep("map")}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button
                onClick={handleCommit}
                disabled={commit.isPending || validation.batchErrors.length > 0 || (validation.validRows === 0 && (!skipDuplicates || validation.duplicateRows === 0))}
              >
                {commit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Import {computeImportable(validation, skipDuplicates)} {entityType}
                {computeImportable(validation, skipDuplicates) === 1 ? "" : "s"}
              </Button>
            </>
          )}
          {step === "done" && (
            <Button onClick={() => handleClose(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function computeImportable(v: ImportValidateResult, skipDuplicates: boolean): number {
  return skipDuplicates ? v.validRows : v.validRows + v.duplicateRows;
}

function StepIndicator({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "upload", label: "Upload" },
    { key: "map", label: "Map" },
    { key: "review", label: "Review" },
    { key: "done", label: "Done" },
  ];
  const activeIdx = steps.findIndex((s) => s.key === step);
  return (
    <div className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <React.Fragment key={s.key}>
          <div
            className={`flex items-center gap-1.5 ${i <= activeIdx ? "text-foreground font-medium" : "text-muted-foreground"}`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                i < activeIdx ? "bg-primary text-primary-foreground" : i === activeIdx ? "bg-primary/20 text-primary" : "bg-muted"
              }`}
            >
              {i + 1}
            </span>
            {s.label}
          </div>
          {i < steps.length - 1 && <div className="h-px w-6 bg-border" />}
        </React.Fragment>
      ))}
    </div>
  );
}

function UploadStep({
  onFile,
  loading,
  fileName,
}: {
  onFile: (file: File | undefined) => void;
  loading: boolean;
  fileName: string;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div className="py-4">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFile(e.dataTransfer.files?.[0]);
        }}
        className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-colors ${
          dragOver ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
        }`}
      >
        {loading ? (
          <Loader2 className="h-10 w-10 text-primary animate-spin" />
        ) : fileName ? (
          <FileSpreadsheet className="h-10 w-10 text-primary" />
        ) : (
          <UploadCloud className="h-10 w-10 text-muted-foreground" />
        )}
        <div className="text-center">
          <div className="text-sm font-medium">
            {loading ? "Parsing file..." : fileName || "Drop a CSV or Excel file, or click to browse"}
          </div>
          <div className="text-xs text-muted-foreground mt-1">.csv, .xlsx — up to 5,000 rows</div>
        </div>
        <input
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          disabled={loading}
          onChange={(e) => onFile(e.target.files?.[0] ?? undefined)}
        />
      </label>
    </div>
  );
}

function MapStep({
  preview,
  mapping,
  onChange,
}: {
  preview: ImportPreviewResult;
  mapping: Record<string, string | null>;
  onChange: (col: string, field: string | null) => void;
}) {
  const requiredUnmapped = preview.availableFields.filter(
    (f) => f.required && !Object.values(mapping).includes(f.key),
  );
  return (
    <div className="space-y-4 py-2">
      <div className="text-sm text-muted-foreground">
        Found <strong className="text-foreground">{preview.rowCount}</strong> rows and{" "}
        <strong className="text-foreground">{preview.columns.length}</strong> columns. Map each column to a field, or skip it.
      </div>

      {requiredUnmapped.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Required field{requiredUnmapped.length > 1 ? "s" : ""} not mapped:{" "}
            {requiredUnmapped.map((f) => f.label).join(", ")}
          </span>
        </div>
      )}

      <div className="rounded-md border divide-y max-h-[280px] overflow-y-auto">
        {preview.columns.map((col) => {
          const sample = preview.sampleRows[0]?.[col];
          return (
            <div key={col} className="flex items-center gap-3 p-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{col}</div>
                {sample ? <div className="text-xs text-muted-foreground truncate">e.g. {sample}</div> : null}
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
              <Select
                value={mapping[col] ?? SKIP}
                onValueChange={(v) => onChange(col, v === SKIP ? null : v)}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Skip this column" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SKIP}>Skip this column</SelectItem>
                  {preview.availableFields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                      {f.required ? " *" : ""}
                      {f.custom ? " (custom)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReviewStep({
  validation,
  entityType,
  skipDuplicates,
  onSkipChange,
}: {
  validation: ImportValidateResult;
  entityType: EntityType;
  skipDuplicates: boolean;
  onSkipChange: (v: boolean) => void;
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="grid grid-cols-4 gap-2">
        <Stat label="Total" value={validation.totalRows} />
        <Stat label="Valid" value={validation.validRows} tone="green" />
        <Stat label="Errors" value={validation.errorRows} tone={validation.errorRows > 0 ? "red" : undefined} />
        <Stat label="Duplicates" value={validation.duplicateRows} tone={validation.duplicateRows > 0 ? "amber" : undefined} />
      </div>

      {validation.batchErrors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive space-y-1">
          {validation.batchErrors.map((e, i) => (
            <div key={i} className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {e}
            </div>
          ))}
        </div>
      )}

      {validation.duplicateRows > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={skipDuplicates} onCheckedChange={(v) => onSkipChange(v === true)} />
          <span>Skip likely duplicates ({validation.duplicateRows})</span>
        </label>
      )}

      {validation.rowErrors.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium mb-1.5">
            <AlertTriangle className="h-4 w-4 text-destructive" /> Rows with errors
          </div>
          <div className="rounded-md border max-h-[180px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Row</TableHead>
                  <TableHead>Issues</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {validation.rowErrors.slice(0, 100).map((r) => (
                  <TableRow key={r.row}>
                    <TableCell className="font-mono text-xs">{r.row}</TableCell>
                    <TableCell className="text-xs text-destructive">{r.errors.join("; ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {validation.duplicates.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium mb-1.5">
            <Copy className="h-4 w-4 text-amber-600" /> Likely duplicates
          </div>
          <div className="rounded-md border max-h-[140px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Row</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {validation.duplicates.slice(0, 100).map((d) => (
                  <TableRow key={d.row}>
                    <TableCell className="font-mono text-xs">{d.row}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{d.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {validation.validRows === 0 && validation.duplicateRows === 0 && validation.batchErrors.length === 0 && (
        <div className="text-sm text-muted-foreground">No importable rows were found in this file.</div>
      )}
    </div>
  );
}

function DoneStep({
  committed,
  entityType,
}: {
  committed: { imported: number; skippedDuplicates: number; skippedErrors: number };
  entityType: EntityType;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <CheckCircle2 className="h-12 w-12 text-green-600" />
      <div className="text-lg font-semibold">
        Imported {committed.imported} {entityType}
        {committed.imported === 1 ? "" : "s"}
      </div>
      <div className="text-sm text-muted-foreground space-x-3">
        {committed.skippedDuplicates > 0 && <span>{committed.skippedDuplicates} duplicates skipped</span>}
        {committed.skippedErrors > 0 && <span>{committed.skippedErrors} rows with errors skipped</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "green" | "red" | "amber" }) {
  const toneClass =
    tone === "green"
      ? "text-green-600"
      : tone === "red"
        ? "text-destructive"
        : tone === "amber"
          ? "text-amber-600"
          : "text-foreground";
  return (
    <div className="rounded-md border p-2.5 text-center">
      <div className={`text-xl font-bold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
