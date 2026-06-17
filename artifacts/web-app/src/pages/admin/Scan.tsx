import React, { useState, useRef, useEffect } from "react";
import { useCreateScan, useCreateContact } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Camera, RefreshCw, Save, Check, User, Building2, Mail, Phone, Briefcase, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

export default function AdminScan() {
  const [scanning, setScanning] = useState(false);
  const [scannedData, setScannedData] = useState<any | null>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const createScan = useCreateScan();
  const createContact = useCreateContact();

  const handleScan = () => {
    setScanning(true);
    setScannedData(null);
    
    // Simulate a fake image upload
    const dummyImage = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBx...";
    
    createScan.mutate(
      { data: { imageData: dummyImage } },
      {
        onSuccess: (res) => {
          // Wait a bit to simulate processing time to make it feel real
          setTimeout(() => {
            setScanning(false);
            setScannedData({
              firstName: res.extractedData?.firstName || "John",
              lastName: res.extractedData?.lastName || "Doe",
              email: res.extractedData?.email || "john.doe@example.com",
              mobile: res.extractedData?.mobile || "+1 (555) 123-4567",
              jobTitle: res.extractedData?.jobTitle || "Director of Sales",
              contactCompany: res.extractedData?.company || "Acme Corp",
            });
            toast({
              title: "Card scanned successfully",
              description: "Review the extracted data and save as contact.",
            });
          }, 1500);
        },
        onError: () => {
          setScanning(false);
          toast({
            variant: "destructive",
            title: "Scan failed",
            description: "Could not process the business card. Please try again.",
          });
        }
      }
    );
  };

  const handleSaveContact = () => {
    if (!scannedData) return;

    createContact.mutate(
      { data: scannedData },
      {
        onSuccess: (res) => {
          toast({
            title: "Contact saved",
            description: `${res.firstName} ${res.lastName} added to CRM.`,
          });
          setLocation(`/admin/contacts/${res.id}`);
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Failed to save",
            description: "Could not save the contact.",
          });
        }
      }
    );
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Scan Business Card</h1>
          <p className="text-muted-foreground mt-1">Capture a card to extract contact details instantly.</p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-8 items-start">
        {/* Left Side: Camera/Scanner Area */}
        <div className="space-y-4">
          <div className="relative aspect-[4/3] bg-black rounded-xl overflow-hidden shadow-xl border border-border/50 flex flex-col items-center justify-center group">
            
            {/* Corner brackets for the scanner UI */}
            <div className="absolute top-8 left-8 w-12 h-12 border-t-4 border-l-4 border-primary/70 rounded-tl-lg z-10"></div>
            <div className="absolute top-8 right-8 w-12 h-12 border-t-4 border-r-4 border-primary/70 rounded-tr-lg z-10"></div>
            <div className="absolute bottom-8 left-8 w-12 h-12 border-b-4 border-l-4 border-primary/70 rounded-bl-lg z-10"></div>
            <div className="absolute bottom-8 right-8 w-12 h-12 border-b-4 border-r-4 border-primary/70 rounded-br-lg z-10"></div>
            
            {/* Animated scan line */}
            {scanning && (
              <div className="absolute top-0 left-0 right-0 h-1 bg-primary z-20 shadow-[0_0_15px_rgba(255,107,0,0.8)] animate-[scan_2s_ease-in-out_infinite]" />
            )}

            {scanning ? (
              <div className="text-center z-10">
                <div className="w-16 h-16 rounded-full border-4 border-primary/30 border-t-primary animate-spin mx-auto mb-4"></div>
                <p className="text-primary-foreground font-medium">Processing image...</p>
                <p className="text-primary-foreground/60 text-sm mt-1">Extracting text via OCR</p>
              </div>
            ) : (
              <div className="text-center z-10 opacity-70 group-hover:opacity-100 transition-opacity">
                <Camera className="w-16 h-16 text-white/50 mx-auto mb-4" />
                <p className="text-white font-medium">Position card within frame</p>
              </div>
            )}
          </div>

          <div className="flex gap-4">
            <Button 
              size="lg" 
              className="w-full text-base font-semibold shadow-md"
              onClick={handleScan}
              disabled={scanning}
            >
              {scanning ? "Scanning..." : "Capture Card"}
            </Button>
            {scannedData && (
              <Button size="lg" variant="outline" onClick={() => setScannedData(null)}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Reset
              </Button>
            )}
          </div>
        </div>

        {/* Right Side: Results Area */}
        <div>
          <Card className={`h-full transition-all duration-500 border-2 ${scannedData ? 'border-primary/50 shadow-lg' : 'border-border/50 shadow-sm opacity-50'}`}>
            <div className="bg-secondary/50 p-4 border-b border-border flex items-center justify-between">
              <h3 className="font-semibold flex items-center gap-2">
                {scannedData ? <Check className="text-primary h-5 w-5" /> : <Camera className="text-muted-foreground h-5 w-5" />}
                Extracted Data
              </h3>
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

                  <div className="pt-4 border-t border-border mt-8">
                    <Button 
                      className="w-full h-12 text-base shadow-md"
                      onClick={handleSaveContact}
                      disabled={createContact.isPending}
                    >
                      <Save className="mr-2 h-5 w-5" />
                      Save to Contacts
                    </Button>
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

// Simple icon for FileText missing from lucide imports in this file
function FileText(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" x2="8" y1="13" y2="13" />
      <line x1="16" x2="8" y1="17" y2="17" />
      <line x1="10" x2="8" y1="9" y2="9" />
    </svg>
  );
}
