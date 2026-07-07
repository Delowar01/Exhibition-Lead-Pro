import React, { useState, useRef, useEffect } from "react";
import {
  useCreateScan,
  useCreateContact,
  useReprocessScan,
  useReplaceScanImage,
  useScoreScan,
  useAnalyzeCapture,
} from "@workspace/api-client-react";
import type {
  CaptureAnalysis,
  CaptureFields,
  Scan,
  ContactInput,
  ExistingContactFound,
} from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";
import { ExistingContactDialog } from "@/components/ExistingContactDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Camera,
  RefreshCw,
  Save,
  Check,
  User,
  Building2,
  Mail,
  Phone,
  Briefcase,
  Globe,
  Linkedin,
  MapPin,
  Languages,
  Upload,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Sparkles,
  Image as ImageIcon,
  Loader2,
  Flame,
  FileText,
  AlertTriangle,
  Users,
  CheckCircle2,
  XCircle,
  Lightbulb,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation, Link } from "wouter";

interface ScannedFields {
  firstName: string;
  lastName: string;
  arabicName: string;
  jobTitle: string;
  contactCompany: string;
  email: string;
  mobile: string;
  website: string;
  linkedin: string;
  address: string;
  city: string;
  country: string;
  postalCode: string;
}

interface LeadScorePreview {
  score: number;
  temperature: "hot" | "warm" | "cold";
  reasoning: string;
}

const emptyFields = (): ScannedFields => ({
  firstName: "",
  lastName: "",
  arabicName: "",
  jobTitle: "",
  contactCompany: "",
  email: "",
  mobile: "",
  website: "",
  linkedin: "",
  address: "",
  city: "",
  country: "",
  postalCode: "",
});

function fieldsFromExtracted(ex: {
  firstName?: string | null;
  lastName?: string | null;
  arabicName?: string | null;
  jobTitle?: string | null;
  company?: string | null;
  email?: string | null;
  mobile?: string | null;
  website?: string | null;
  linkedin?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  postalCode?: string | null;
}): ScannedFields {
  return {
    firstName: ex.firstName ?? "",
    lastName: ex.lastName ?? "",
    arabicName: ex.arabicName ?? "",
    jobTitle: ex.jobTitle ?? "",
    contactCompany: ex.company ?? "",
    email: ex.email ?? "",
    mobile: ex.mobile ?? "",
    website: ex.website ?? "",
    linkedin: ex.linkedin ?? "",
    address: ex.address ?? "",
    city: ex.city ?? "",
    country: ex.country ?? "",
    postalCode: ex.postalCode ?? "",
  };
}

const TEMP_STYLES: Record<string, string> = {
  hot: "bg-red-100 text-red-700 border-red-200",
  warm: "bg-amber-100 text-amber-700 border-amber-200",
  cold: "bg-sky-100 text-sky-700 border-sky-200",
};

// Map capture-field names (as used by the analyze API) back to the editable form state keys.
const CAPTURE_TO_STATE: Record<string, keyof ScannedFields> = {
  firstName: "firstName",
  lastName: "lastName",
  jobTitle: "jobTitle",
  company: "contactCompany",
  email: "email",
  mobile: "mobile",
  website: "website",
  linkedin: "linkedin",
  address: "address",
  city: "city",
  country: "country",
  postalCode: "postalCode",
};

const FIELD_LABELS: Record<string, string> = {
  firstName: "First Name",
  lastName: "Last Name",
  jobTitle: "Job Title",
  company: "Company",
  email: "Email",
  mobile: "Phone",
  officePhone: "Office Phone",
  website: "Website",
  linkedin: "LinkedIn",
  address: "Address",
  city: "City",
  country: "Country",
  postalCode: "Postal Code",
  industry: "Industry",
};

// Build the analyze request body from the editable form state. Only include fields
// that actually exist in state (company maps from contactCompany). Empty strings are
// dropped so the backend never receives blank placeholders.
function buildCaptureFields(d: ScannedFields): CaptureFields {
  const fields: CaptureFields = {};
  const add = (key: keyof CaptureFields, value: string) => {
    const trimmed = value.trim();
    if (trimmed) fields[key] = trimmed;
  };
  add("firstName", d.firstName);
  add("lastName", d.lastName);
  add("jobTitle", d.jobTitle);
  add("company", d.contactCompany);
  add("email", d.email);
  add("mobile", d.mobile);
  add("website", d.website);
  add("linkedin", d.linkedin);
  add("address", d.address);
  add("city", d.city);
  add("country", d.country);
  add("postalCode", d.postalCode);
  return fields;
}

const VALIDATION_STYLES: Record<string, string> = {
  invalid: "bg-red-100 text-red-700 border-red-200",
  warning: "bg-amber-100 text-amber-700 border-amber-200",
};

const MATCH_TYPE_STYLES: Record<string, string> = {
  exact: "bg-primary/10 text-primary border-primary/20",
  partial: "bg-secondary text-secondary-foreground border-border",
};

export default function AdminScan() {
  const [scanning, setScanning] = useState(false);
  const [scannedData, setScannedData] = useState<ScannedFields | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [cardImage, setCardImage] = useState<string | null>(null);
  const [scanId, setScanId] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [leadScore, setLeadScore] = useState<LeadScorePreview | null>(null);
  const [scanMeta, setScanMeta] = useState<{
    aiModel: string | null;
    promptVersion: number | null;
    processingTimeMs: number | null;
    qualityScore: number | null;
    extractionMethod: string | null;
    fieldConfidences: Record<string, number> | null;
  } | null>(null);
  const applyScanMeta = (res: Scan) => {
    setScanMeta({
      aiModel: res.aiModel ?? null,
      promptVersion: res.promptVersion ?? null,
      processingTimeMs: res.processingTimeMs ?? null,
      qualityScore: res.qualityScore ?? null,
      extractionMethod: res.extractionMethod ?? null,
      fieldConfidences: (res.fieldConfidences as Record<string, number> | null) ?? null,
    });
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [analysis, setAnalysis] = useState<CaptureAnalysis | null>(null);

  const createScan = useCreateScan();
  const createContact = useCreateContact();
  const reprocessScan = useReprocessScan();
  const replaceScanImage = useReplaceScanImage();
  const scoreScan = useScoreScan();
  const analyzeCapture = useAnalyzeCapture();

  // Debounced capture-intelligence analysis. Runs after a successful scan (when
  // scannedData is first set) and whenever the user edits the extracted fields.
  useEffect(() => {
    if (!scannedData) {
      setAnalysis(null);
      return;
    }
    const fields = buildCaptureFields(scannedData);
    if (Object.keys(fields).length === 0) {
      setAnalysis(null);
      return;
    }
    const timer = setTimeout(() => {
      analyzeCapture.mutate(
        { data: { fields, includeAi: true } },
        { onSuccess: (res) => setAnalysis(res) }
      );
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannedData]);

  const handleRecheck = () => {
    if (!scannedData) return;
    const fields = buildCaptureFields(scannedData);
    if (Object.keys(fields).length === 0) return;
    analyzeCapture.mutate(
      { data: { fields, includeAi: true } },
      {
        onSuccess: (res) => {
          setAnalysis(res);
          toast({ title: "Capture intelligence updated", description: "Recognition and suggestions refreshed." });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Analysis unavailable",
            description: "Could not analyze the captured fields. Please try again.",
          });
        },
      }
    );
  };

  const applySuggestion = (field: string, value: string) => {
    if (!scannedData) return;
    const key = CAPTURE_TO_STATE[field];
    if (!key) return;
    setScannedData({ ...scannedData, [key]: value });
  };

  const resetView = () => {
    setScale(1);
    setRotation(0);
  };

  const handleCaptureClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const imageData = reader.result as string;
      setCardImage(imageData);
      setScannedData(null);
      setConfidence(null);
      setScanMeta(null);
      setScanId(null);
      setLeadScore(null);
      resetView();
      setScanning(true);

      createScan.mutate(
        { data: { imageData } },
        {
          onSuccess: (res) => {
            setScanning(false);
            setScanId(res.id);
            const ex = res.extractedData;
            if (res.status !== "completed" || !ex) {
              toast({
                variant: "destructive",
                title: "Could not read the card",
                description:
                  "No details were extracted. Use Reprocess OCR or replace the image below.",
              });
              setScannedData(emptyFields());
              return;
            }
            setConfidence(res.confidence ?? null);
            applyScanMeta(res);
            setScannedData(fieldsFromExtracted(ex));
            toast({
              title: "Card scanned successfully",
              description: "Review the extracted data and save as a contact.",
            });
          },
          onError: () => {
            setScanning(false);
            setCardImage(null);
            toast({
              variant: "destructive",
              title: "Scan failed",
              description: "Could not read the card. Please retake the photo.",
            });
          },
        }
      );
    };
    reader.onerror = () => {
      toast({ variant: "destructive", title: "Could not read file", description: "Please try a different image." });
    };
    reader.readAsDataURL(file);
  };

  const handleReset = () => {
    setScannedData(null);
    setConfidence(null);
    setScanMeta(null);
    setCardImage(null);
    setScanId(null);
    setLeadScore(null);
    resetView();
  };

  const handleReprocess = () => {
    if (!scanId) return;
    setLeadScore(null);
    reprocessScan.mutate(
      { id: scanId, data: { appLanguage: "en" } },
      {
        onSuccess: (res) => {
          const ex = res.extractedData;
          setConfidence(res.confidence ?? null);
          applyScanMeta(res);
          setScannedData(ex ? fieldsFromExtracted(ex) : emptyFields());
          toast({ title: "OCR re-run", description: "Fields updated from the stored image." });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Could not reprocess",
            description: "The card could not be re-read. Try replacing the image.",
          });
        },
      }
    );
  };

  const handleScore = () => {
    if (!scanId) return;
    scoreScan.mutate(
      { id: scanId },
      {
        onSuccess: (res) => {
          setLeadScore(res);
          toast({ title: "AI lead score ready", description: `Score ${res.score}/100 — ${res.temperature}.` });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Scoring unavailable",
            description: "AI scoring is temporarily unavailable. Please try again.",
          });
        },
      }
    );
  };

  const handleReplaceClick = () => {
    replaceInputRef.current?.click();
  };

  const handleReplaceFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !scanId) return;

    const reader = new FileReader();
    reader.onload = () => {
      const imageData = reader.result as string;
      setLeadScore(null);
      replaceScanImage.mutate(
        { id: scanId, data: { imageData, appLanguage: "en" } },
        {
          onSuccess: (res) => {
            setCardImage(imageData);
            resetView();
            const ex = res.extractedData;
            setConfidence(res.confidence ?? null);
            applyScanMeta(res);
            setScannedData(ex ? fieldsFromExtracted(ex) : emptyFields());
            toast({ title: "Image replaced", description: "New image stored and re-read." });
          },
          onError: () => {
            toast({
              variant: "destructive",
              title: "Could not replace image",
              description: "The image could not be stored or re-read. Please try again.",
            });
          },
        }
      );
    };
    reader.onerror = () => {
      toast({ variant: "destructive", title: "Could not read file", description: "Please try a different image." });
    };
    reader.readAsDataURL(file);
  };

  const [existingContact, setExistingContact] = useState<ExistingContactFound | null>(null);
  const [dedupeDialogOpen, setDedupeDialogOpen] = useState(false);

  const buildContactPayload = (
    resolution?: "add_interaction" | "create_separate",
    matchedContactId?: number
  ): ContactInput => {
    const payload: ContactInput = {
      ...scannedData,
      cardImageUrl: cardImage,
      scanId: scanId ?? undefined,
    };
    if (resolution) payload.dedupeResolution = resolution;
    if (matchedContactId != null) payload.matchedContactId = matchedContactId;
    return payload;
  };

  const saveContactSuccess = (res: { id: number; firstName?: string | null; lastName?: string | null }) => {
    toast({
      title: "Contact saved",
      description: `${res.firstName ?? ""} ${res.lastName ?? ""} added to CRM.`.trim(),
    });
    setLocation(`/admin/contacts/${res.id}`);
  };

  const handleSaveContact = () => {
    if (!scannedData) return;

    createContact.mutate(
      { data: buildContactPayload() },
      {
        onSuccess: saveContactSuccess,
        onError: (err) => {
          if (
            err instanceof ApiError &&
            err.status === 409 &&
            (err.data as ExistingContactFound | null)?.code === "existing_contact_found"
          ) {
            setExistingContact(err.data as ExistingContactFound);
            setDedupeDialogOpen(true);
            return;
          }
          toast({
            variant: "destructive",
            title: "Failed to save",
            description: "Could not save the contact.",
          });
        },
      }
    );
  };

  const handleAddInteraction = (matchedContactId: number) => {
    createContact.mutate(
      { data: buildContactPayload("add_interaction", matchedContactId) },
      {
        onSuccess: (res) => {
          setDedupeDialogOpen(false);
          toast({ title: "Interaction added", description: "The capture was linked to the existing contact." });
          setLocation(`/admin/contacts/${res.id}`);
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed to add interaction", description: "Could not link the capture." });
        },
      }
    );
  };

  const handleCreateSeparate = () => {
    createContact.mutate(
      { data: buildContactPayload("create_separate") },
      {
        onSuccess: (res) => {
          setDedupeDialogOpen(false);
          saveContactSuccess(res);
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed to save", description: "Could not save the contact." });
        },
      }
    );
  };

  const reviewReady = scanId !== null && !scanning;
  const busy = reprocessScan.isPending || replaceScanImage.isPending || scoreScan.isPending;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileChange}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleReplaceFileChange}
      />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Scan Business Card</h1>
          <p className="text-muted-foreground mt-1">Capture or upload a card to extract contact details with AI.</p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-8 items-start">
        {/* Left Side: Camera/Scanner + OCR Review Center */}
        <div className="space-y-4">
          <div className="relative aspect-[4/3] bg-black rounded-xl overflow-hidden shadow-xl border border-border/50 flex flex-col items-center justify-center group">

            {/* Captured image preview (zoom + rotate) */}
            {cardImage && (
              <img
                src={cardImage}
                alt="Captured card"
                className="absolute inset-0 w-full h-full object-contain z-0 transition-transform duration-150"
                style={{ transform: `scale(${scale}) rotate(${rotation}deg)` }}
              />
            )}

            {/* Corner brackets for the scanner UI */}
            <div className="absolute top-8 left-8 w-12 h-12 border-t-4 border-l-4 border-primary/70 rounded-tl-lg z-10"></div>
            <div className="absolute top-8 right-8 w-12 h-12 border-t-4 border-r-4 border-primary/70 rounded-tr-lg z-10"></div>
            <div className="absolute bottom-8 left-8 w-12 h-12 border-b-4 border-l-4 border-primary/70 rounded-bl-lg z-10"></div>
            <div className="absolute bottom-8 right-8 w-12 h-12 border-b-4 border-r-4 border-primary/70 rounded-br-lg z-10"></div>

            {/* Animated scan line */}
            {scanning && (
              <div className="absolute top-0 left-0 right-0 h-1 bg-primary z-20 shadow-[0_0_15px_rgba(255,107,0,0.8)] animate-[scan_2s_ease-in-out_infinite]" />
            )}

            {/* Zoom / rotate controls */}
            {cardImage && !scanning && (
              <div className="absolute bottom-3 right-3 z-20 flex gap-1.5 bg-black/50 backdrop-blur-sm rounded-lg p-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-white hover:bg-white/20"
                  onClick={() => setScale((s) => Math.min(3, +(s + 0.25).toFixed(2)))}
                  aria-label="Zoom in"
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-white hover:bg-white/20"
                  onClick={() => setScale((s) => Math.max(1, +(s - 0.25).toFixed(2)))}
                  aria-label="Zoom out"
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-white hover:bg-white/20"
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                  aria-label="Rotate"
                >
                  <RotateCw className="h-4 w-4" />
                </Button>
              </div>
            )}

            {scanning ? (
              <div className="text-center z-10 bg-black/40 px-6 py-4 rounded-lg backdrop-blur-sm">
                <div className="w-16 h-16 rounded-full border-4 border-primary/30 border-t-primary animate-spin mx-auto mb-4"></div>
                <p className="text-primary-foreground font-medium">Reading card...</p>
                <p className="text-primary-foreground/60 text-sm mt-1">Extracting details with AI</p>
              </div>
            ) : !cardImage ? (
              <div className="text-center z-10 opacity-70 group-hover:opacity-100 transition-opacity">
                <Camera className="w-16 h-16 text-white/50 mx-auto mb-4" />
                <p className="text-white font-medium">Position card within frame</p>
                <p className="text-white/50 text-sm mt-1">Use your camera or upload an image</p>
              </div>
            ) : null}
          </div>

          <div className="flex gap-4">
            <Button
              size="lg"
              className="w-full text-base font-semibold shadow-md"
              onClick={handleCaptureClick}
              disabled={scanning}
            >
              <Upload className="h-4 w-4 mr-2" />
              {scanning ? "Scanning..." : cardImage ? "Capture Another" : "Capture or Upload Card"}
            </Button>
            {scannedData && (
              <Button size="lg" variant="outline" onClick={handleReset}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Reset
              </Button>
            )}
          </div>

          {/* OCR Review Center actions — operate on the stored scan */}
          {reviewReady && (
            <Card className="border-border/60">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Sparkles className="h-4 w-4 text-primary" /> OCR Review Center
                </div>
                <p className="text-xs text-muted-foreground">
                  Re-read the stored image, re-run AI scoring, or replace the photo. All actions run against this saved scan.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <Button variant="outline" size="sm" onClick={handleReprocess} disabled={busy}>
                    {reprocessScan.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-1" />
                    )}
                    Reprocess
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleScore} disabled={busy}>
                    {scoreScan.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-1" />
                    )}
                    Re-run AI
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleReplaceClick} disabled={busy}>
                    {replaceScanImage.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <ImageIcon className="h-4 w-4 mr-1" />
                    )}
                    Replace
                  </Button>
                </div>

                {leadScore && (
                  <div className="rounded-lg border border-border/60 bg-secondary/40 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium flex items-center gap-1">
                        <Flame className="h-4 w-4 text-primary" /> AI Lead Score
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-semibold">{leadScore.score}/100</Badge>
                        <Badge className={`border capitalize ${TEMP_STYLES[leadScore.temperature] ?? ""}`}>
                          {leadScore.temperature}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{leadScore.reasoning}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Capture Intelligence — validation, recognition, and suggestions (advisory only) */}
          {scannedData && (
            <Card className="border-border/60">
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="h-4 w-4 text-primary" /> Capture Intelligence
                    {analyzeCapture.isPending && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRecheck}
                    disabled={analyzeCapture.isPending}
                    className="h-8"
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    Re-check
                  </Button>
                </div>

                {!analysis && !analyzeCapture.isPending && (
                  <p className="text-xs text-muted-foreground">
                    Recognition and suggestions will appear here as you review the extracted fields.
                  </p>
                )}

                {analysis && (
                  <div className="space-y-4">
                    {/* Duplicate warning — advisory only, never auto-merge */}
                    {analysis.duplicateWarning.isLikelyDuplicate && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                        <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                          <AlertTriangle className="h-4 w-4" /> Possible duplicate
                          <Badge variant="outline" className="ml-auto border-amber-300 text-amber-700">
                            {analysis.duplicateWarning.topMatchConfidence}% match
                          </Badge>
                        </div>
                        {analysis.duplicateWarning.message && (
                          <p className="text-xs text-amber-700 leading-relaxed">
                            {analysis.duplicateWarning.message}
                          </p>
                        )}
                        <p className="text-[11px] text-amber-600">
                          Review before saving — nothing is merged automatically.
                        </p>
                      </div>
                    )}

                    {/* Contact matches */}
                    {analysis.contactMatches.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <Users className="h-3.5 w-3.5" /> Similar contacts
                        </div>
                        <div className="space-y-2">
                          {analysis.contactMatches.map((m) => (
                            <Link
                              key={m.contactId}
                              href={`/admin/contacts/${m.contactId}`}
                              className="block rounded-lg border border-border/60 p-2.5 hover:border-primary/40 hover:bg-secondary/40 transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium truncate">
                                  {m.fullName || m.email || `Contact #${m.contactId}`}
                                </span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <Badge variant="secondary" className="text-[11px]">
                                    {m.confidence}%
                                  </Badge>
                                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                                </div>
                              </div>
                              {(m.contactCompany || m.email) && (
                                <p className="text-xs text-muted-foreground truncate mt-0.5">
                                  {[m.contactCompany, m.email].filter(Boolean).join(" · ")}
                                </p>
                              )}
                              {m.reasons.length > 0 && (
                                <p className="text-[11px] text-muted-foreground mt-1">
                                  {m.reasons.join(", ")}
                                </p>
                              )}
                              {(m.isCustomer || m.isLead || m.isDecisionMaker) && (
                                <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                                  {m.isCustomer && (
                                    <Badge className="text-[10px] border bg-emerald-100 text-emerald-700 border-emerald-200">
                                      Existing customer
                                    </Badge>
                                  )}
                                  {m.isLead && !m.isCustomer && (
                                    <Badge className="text-[10px] border bg-sky-100 text-sky-700 border-sky-200">
                                      Active lead{typeof m.leadCount === "number" && m.leadCount > 1 ? ` ×${m.leadCount}` : ""}
                                    </Badge>
                                  )}
                                  {m.isDecisionMaker && (
                                    <Badge className="text-[10px] border bg-violet-100 text-violet-700 border-violet-200">
                                      Decision maker
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Organization recognition */}
                    {analysis.organizationMatches.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <Building2 className="h-3.5 w-3.5" /> Organizations
                        </div>
                        <div className="space-y-2">
                          {analysis.organizationMatches.map((o) => (
                            <Link
                              key={o.organizationId}
                              href={`/admin/companies/${o.organizationId}`}
                              className="block rounded-lg border border-border/60 p-2.5 hover:border-primary/40 hover:bg-secondary/40 transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium truncate">{o.name}</span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <Badge className={`border capitalize text-[11px] ${MATCH_TYPE_STYLES[o.matchType] ?? ""}`}>
                                    {o.matchType}
                                  </Badge>
                                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                                </div>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {o.contactCount} contact{o.contactCount === 1 ? "" : "s"} · {o.leadCount} lead
                                {o.leadCount === 1 ? "" : "s"}
                                {o.industry ? ` · ${o.industry}` : ""}
                              </p>
                              {o.relationshipSummary && (
                                <p className="text-[11px] text-muted-foreground mt-1">{o.relationshipSummary}</p>
                              )}
                              {(o.recentEvents?.length ?? 0) > 0 && (
                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                  Seen at: {o.recentEvents!.join(", ")}
                                </p>
                              )}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Similar-record warnings — advisory only, never auto-merge */}
                    {(analysis.similarWarnings?.length ?? 0) > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <AlertTriangle className="h-3.5 w-3.5" /> Similar records
                        </div>
                        <div className="space-y-1.5">
                          {analysis.similarWarnings!.map((w, i) => (
                            <div
                              key={`${w.kind}-${i}`}
                              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-2.5"
                            >
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                              <div className="min-w-0 flex-1">
                                <p className="text-xs text-amber-800">
                                  {w.contactId ? (
                                    <Link href={`/admin/contacts/${w.contactId}`} className="underline underline-offset-2 hover:text-amber-900">
                                      {w.message}
                                    </Link>
                                  ) : (
                                    w.message
                                  )}
                                </p>
                              </div>
                              <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 shrink-0">
                                {w.confidence}%
                              </Badge>
                            </div>
                          ))}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Advisory only — nothing is linked or merged automatically.
                        </p>
                      </div>
                    )}

                    {/* Field validation */}
                    {analysis.validation.validations.some(
                      (v) => v.status === "invalid" || v.status === "warning"
                    ) && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Validation
                        </div>
                        <div className="space-y-1.5">
                          {analysis.validation.validations
                            .filter((v) => v.status === "invalid" || v.status === "warning")
                            .map((v, i) => (
                              <div key={`${v.field}-${i}`} className="flex items-start gap-2 text-xs">
                                {v.status === "invalid" ? (
                                  <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                                ) : (
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                                )}
                                <div className="min-w-0">
                                  <span className="font-medium">{FIELD_LABELS[v.field] ?? v.field}</span>
                                  {v.message && (
                                    <span className="text-muted-foreground"> — {v.message}</span>
                                  )}
                                </div>
                                <Badge
                                  variant="outline"
                                  className={`border capitalize ml-auto text-[10px] ${VALIDATION_STYLES[v.status] ?? ""}`}
                                >
                                  {v.status}
                                </Badge>
                              </div>
                            ))}
                        </div>
                        {(analysis.validation.detectedCountry || analysis.validation.detectedDialCode) && (
                          <p className="text-[11px] text-muted-foreground">
                            Detected{analysis.validation.detectedCountry ? ` ${analysis.validation.detectedCountry}` : ""}
                            {analysis.validation.detectedDialCode ? ` (${analysis.validation.detectedDialCode})` : ""}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Smart suggestions */}
                    {analysis.suggestions.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <Lightbulb className="h-3.5 w-3.5" /> Suggestions
                        </div>
                        <div className="space-y-2">
                          {analysis.suggestions.map((s, i) => {
                            const applicable = !!CAPTURE_TO_STATE[s.field];
                            return (
                              <div
                                key={`${s.field}-${i}`}
                                className="flex items-start gap-2 rounded-lg border border-border/60 p-2.5"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-xs font-medium">{FIELD_LABELS[s.field] ?? s.field}</span>
                                    {s.source === "ai" ? (
                                      <Badge className="text-[10px] border bg-primary/10 text-primary border-primary/20 gap-0.5">
                                        <Sparkles className="h-2.5 w-2.5" /> AI
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-[10px]">
                                        rule
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-sm font-medium truncate mt-0.5">{s.suggested}</p>
                                  <p className="text-[11px] text-muted-foreground">{s.reason}</p>
                                </div>
                                {applicable && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 shrink-0"
                                    onClick={() => applySuggestion(s.field, s.suggested)}
                                  >
                                    Apply
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Fields with no grounded suggestion — honest "not enough information" */}
                    {(analysis.insufficient?.length ?? 0) > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <Lightbulb className="h-3.5 w-3.5" /> Not enough information
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {analysis.insufficient!.map((f) => FIELD_LABELS[f] ?? f).join(", ")} — no grounded
                          suggestion available from this card or your CRM.
                        </p>
                      </div>
                    )}

                    {analysis.aiDegraded && (
                      <p className="text-[11px] text-muted-foreground italic">
                        AI suggestions unavailable — deterministic results still shown.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Side: Results Area */}
        <div>
          <Card className={`h-full transition-all duration-500 border-2 ${scannedData ? 'border-primary/50 shadow-lg' : 'border-border/50 shadow-sm opacity-50'}`}>
            <div className="bg-secondary/50 p-4 border-b border-border flex items-center justify-between">
              <h3 className="font-semibold flex items-center gap-2">
                {scannedData ? <Check className="text-primary h-5 w-5" /> : <Camera className="text-muted-foreground h-5 w-5" />}
                Extracted Data
              </h3>
              {scannedData && confidence != null && (
                <Badge variant="secondary" className="font-medium">
                  {confidence}% confidence
                </Badge>
              )}
            </div>

            <CardContent className="p-6">
              {!scannedData ? (
                <div className="h-[300px] flex flex-col items-center justify-center text-center text-muted-foreground">
                  <FileText className="h-12 w-12 opacity-20 mb-4" />
                  <p>Awaiting scan data...</p>
                  <p className="text-sm mt-1">Capture a card to see extracted fields here.</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {scanMeta && (
                    <div className="rounded-lg border border-border/60 bg-secondary/30 p-4 space-y-3">
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <Sparkles className="h-4 w-4 text-primary" /> OCR Intelligence
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground">
                        {confidence != null && (
                          <div>Overall confidence: <span className="font-medium text-foreground">{confidence}%</span></div>
                        )}
                        {scanMeta.qualityScore != null && (
                          <div>Scan quality: <span className="font-medium text-foreground">{scanMeta.qualityScore}/100</span></div>
                        )}
                        {scanMeta.aiModel && (
                          <div>Model: <span className="font-medium text-foreground">{scanMeta.aiModel}</span></div>
                        )}
                        {scanMeta.promptVersion != null && (
                          <div>Prompt: <span className="font-medium text-foreground">v{scanMeta.promptVersion}</span></div>
                        )}
                        {scanMeta.processingTimeMs != null && (
                          <div>Processing: <span className="font-medium text-foreground">{scanMeta.processingTimeMs} ms</span></div>
                        )}
                        {scanMeta.extractionMethod && (
                          <div>Method: <span className="font-medium text-foreground">{scanMeta.extractionMethod}</span></div>
                        )}
                      </div>
                      {scanMeta.fieldConfidences && Object.keys(scanMeta.fieldConfidences).length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-xs font-medium text-muted-foreground">Per-field confidence</div>
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(scanMeta.fieldConfidences).map(([f, c]) => (
                              <Badge key={f} variant="outline" className="text-[10px] font-normal">
                                {f}: {Math.round(c)}%
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground flex items-center gap-1"><User className="h-3 w-3" /> First Name</Label>
                      <Input value={scannedData.firstName} onChange={(e) => setScannedData({...scannedData, firstName: e.target.value})} className="font-medium" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground flex items-center gap-1"><User className="h-3 w-3" /> Last Name</Label>
                      <Input value={scannedData.lastName} onChange={(e) => setScannedData({...scannedData, lastName: e.target.value})} className="font-medium" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><Languages className="h-3 w-3" /> Arabic Name</Label>
                    <Input dir="rtl" value={scannedData.arabicName} onChange={(e) => setScannedData({...scannedData, arabicName: e.target.value})} placeholder="—" />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><Briefcase className="h-3 w-3" /> Job Title</Label>
                    <Input value={scannedData.jobTitle} onChange={(e) => setScannedData({...scannedData, jobTitle: e.target.value})} />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><Building2 className="h-3 w-3" /> Company</Label>
                    <Input value={scannedData.contactCompany} onChange={(e) => setScannedData({...scannedData, contactCompany: e.target.value})} />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" /> Email Address</Label>
                    <Input value={scannedData.email} onChange={(e) => setScannedData({...scannedData, email: e.target.value})} type="email" />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="h-3 w-3" /> Phone Number</Label>
                    <Input value={scannedData.mobile} onChange={(e) => setScannedData({...scannedData, mobile: e.target.value})} />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground flex items-center gap-1"><Globe className="h-3 w-3" /> Website</Label>
                      <Input value={scannedData.website} onChange={(e) => setScannedData({...scannedData, website: e.target.value})} placeholder="—" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground flex items-center gap-1"><Linkedin className="h-3 w-3" /> LinkedIn</Label>
                      <Input value={scannedData.linkedin} onChange={(e) => setScannedData({...scannedData, linkedin: e.target.value})} placeholder="—" />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" /> Address</Label>
                    <Input value={scannedData.address} onChange={(e) => setScannedData({...scannedData, address: e.target.value})} placeholder="—" />
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">City</Label>
                      <Input value={scannedData.city} onChange={(e) => setScannedData({...scannedData, city: e.target.value})} placeholder="—" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Country</Label>
                      <Input value={scannedData.country} onChange={(e) => setScannedData({...scannedData, country: e.target.value})} placeholder="—" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Postal Code</Label>
                      <Input value={scannedData.postalCode} onChange={(e) => setScannedData({...scannedData, postalCode: e.target.value})} placeholder="—" />
                    </div>
                  </div>

                  <div className="pt-4 border-t border-border mt-8">
                    <Button
                      className="w-full h-12 text-base shadow-md"
                      onClick={handleSaveContact}
                      disabled={createContact.isPending}
                    >
                      <Save className="mr-2 h-5 w-5" />
                      {createContact.isPending ? "Saving & scoring lead..." : "Save to Contacts"}
                    </Button>
                    <p className="text-xs text-muted-foreground text-center mt-2">AI will score this lead automatically on save.</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Add keyframes for scan line animation to global CSS or inline here */}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes scan {
          0% { top: 0%; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { top: 100%; opacity: 0; }
        }
      `}} />

      <ExistingContactDialog
        data={existingContact}
        open={dedupeDialogOpen}
        onOpenChange={setDedupeDialogOpen}
        submitting={createContact.isPending}
        onAddInteraction={handleAddInteraction}
        onCreateSeparate={handleCreateSeparate}
        onReview={(cid) => setLocation(`/admin/contacts/${cid}`)}
      />
    </div>
  );
}
