import React, { useState, useRef } from "react";
import {
  useCreateScan,
  useCreateContact,
  useReprocessScan,
  useReplaceScanImage,
  useScoreScan,
} from "@workspace/api-client-react";
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

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
  };
}

const TEMP_STYLES: Record<string, string> = {
  hot: "bg-red-100 text-red-700 border-red-200",
  warm: "bg-amber-100 text-amber-700 border-amber-200",
  cold: "bg-sky-100 text-sky-700 border-sky-200",
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const createScan = useCreateScan();
  const createContact = useCreateContact();
  const reprocessScan = useReprocessScan();
  const replaceScanImage = useReplaceScanImage();
  const scoreScan = useScoreScan();

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

  const handleSaveContact = () => {
    if (!scannedData) return;

    createContact.mutate(
      { data: { ...scannedData, cardImageUrl: cardImage } },
      {
        onSuccess: (res) => {
          toast({
            title: "Contact saved",
            description: `${res.firstName ?? ""} ${res.lastName ?? ""} added to CRM.`.trim(),
          });
          setLocation(`/admin/contacts/${res.id}`);
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Failed to save",
            description: "Could not save the contact.",
          });
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
    </div>
  );
}
