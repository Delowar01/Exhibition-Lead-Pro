import React from "react";
import { useForm } from "react-hook-form";
import { useGetOrganization, useUpdateOrganization, OrganizationInput } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Building2, Save } from "lucide-react";
import { BrandingSection } from "@/components/branding/BrandingSection";

type OrgForm = Required<Pick<OrganizationInput,
  "name" | "legalName" | "registrationNumber" | "industry" | "website" | "phone" |
  "address" | "country" | "vatNumber" | "timezone" | "currency" |
  "primaryContactName" | "primaryContactEmail"
>>;

const FIELDS: { key: keyof OrgForm; label: string; placeholder?: string }[] = [
  { key: "name", label: "Company Name" },
  { key: "legalName", label: "Legal Name" },
  { key: "registrationNumber", label: "Registration Number" },
  { key: "vatNumber", label: "VAT / Tax Number" },
  { key: "industry", label: "Industry" },
  { key: "website", label: "Website", placeholder: "https://" },
  { key: "phone", label: "Phone" },
  { key: "country", label: "Country" },
  { key: "timezone", label: "Timezone", placeholder: "America/New_York" },
  { key: "currency", label: "Currency", placeholder: "USD" },
  { key: "primaryContactName", label: "Primary Contact Name" },
  { key: "primaryContactEmail", label: "Primary Contact Email" },
];

export default function AdminOrganization() {
  const { toast } = useToast();
  const { data: org, isLoading } = useGetOrganization();
  const update = useUpdateOrganization();

  const { register, handleSubmit, reset } = useForm<OrgForm>();

  React.useEffect(() => {
    if (org) {
      reset({
        name: org.name ?? "",
        legalName: org.legalName ?? "",
        registrationNumber: org.registrationNumber ?? "",
        industry: org.industry ?? "",
        website: org.website ?? "",
        phone: org.phone ?? "",
        address: org.address ?? "",
        country: org.country ?? "",
        vatNumber: org.vatNumber ?? "",
        timezone: org.timezone ?? "",
        currency: org.currency ?? "",
        primaryContactName: org.primaryContactName ?? "",
        primaryContactEmail: org.primaryContactEmail ?? "",
      });
    }
  }, [org, reset]);

  const onSubmit = (values: OrgForm) => {
    const data: OrganizationInput = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, v === "" ? null : v]),
    ) as OrganizationInput;
    update.mutate(
      { data },
      {
        onSuccess: () => toast({ title: "Organization updated" }),
        onError: () => toast({ variant: "destructive", title: "Failed to update organization" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Building2 className="h-7 w-7 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Organization</h1>
        </div>
        {org && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="capitalize">{org.plan}</Badge>
            <Badge variant={org.status === "active" ? "default" : "destructive"} className="capitalize">{org.status}</Badge>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit(onSubmit)}>
        <Card>
          <CardHeader>
            <CardTitle>Company Profile</CardTitle>
            <CardDescription>Manage your organization's legal and contact details.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {isLoading ? (
              <div className="py-8 text-center text-muted-foreground">Loading organization...</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {FIELDS.map((f) => (
                    <div key={f.key} className="space-y-2">
                      <Label htmlFor={f.key}>{f.label}</Label>
                      <Input id={f.key} placeholder={f.placeholder} {...register(f.key)} />
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address">Address</Label>
                  <Input id="address" {...register("address")} />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" disabled={update.isPending}>
                    <Save className="mr-2 h-4 w-4" />
                    {update.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </form>

      <BrandingSection />
    </div>
  );
}
