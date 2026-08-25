import React from "react";
import { useForm } from "react-hook-form";
import { format, parseISO } from "date-fns";
import {
  useGetProfile,
  useUpdateProfile,
  useGetProfileActivity,
  ProfileInput,
  LoginHistoryEntry,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { UserCircle, Save, ShieldCheck } from "lucide-react";

type ProfileForm = { name: string; phone: string; language: string; timezone: string };

function fmt(s?: string | null) {
  if (!s) return "—";
  try {
    return format(parseISO(s), "MMM d, yyyy HH:mm");
  } catch {
    return s;
  }
}

export default function AdminProfile() {
  const { toast } = useToast();
  const { data: profile, isLoading } = useGetProfile();
  const { data: activity } = useGetProfileActivity();
  const update = useUpdateProfile();

  const { register, handleSubmit, reset } = useForm<ProfileForm>();

  React.useEffect(() => {
    if (profile) {
      reset({
        name: profile.name ?? "",
        phone: profile.phone ?? "",
        language: profile.language ?? "en",
        timezone: profile.timezone ?? "",
      });
    }
  }, [profile, reset]);

  const onSubmit = (values: ProfileForm) => {
    const data: ProfileInput = {
      name: values.name,
      phone: values.phone === "" ? null : values.phone,
      language: values.language || "en",
      timezone: values.timezone === "" ? null : values.timezone,
    };
    update.mutate(
      { data },
      {
        onSuccess: () => toast({ title: "Profile updated" }),
        onError: () => toast({ variant: "destructive", title: "Failed to update profile" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <UserCircle className="h-7 w-7 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight">My Profile</h1>
      </div>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <form onSubmit={handleSubmit(onSubmit)}>
            <Card>
              <CardHeader>
                <CardTitle>Personal Details</CardTitle>
                <CardDescription>Update your name, contact, and preferences.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {isLoading ? (
                  <div className="py-8 text-center text-muted-foreground">Loading profile...</div>
                ) : (
                  <>
                    <div className="flex items-center gap-4">
                      <div className="w-16 h-16 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-xl overflow-hidden">
                        {profile?.avatarUrl ? (
                          <img src={profile.avatarUrl} alt="avatar" className="w-full h-full object-cover" />
                        ) : (
                          profile?.name?.substring(0, 2).toUpperCase()
                        )}
                      </div>
                      <div>
                        <div className="font-medium">{profile?.email}</div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="secondary" className="capitalize">{profile?.role?.replace("_", " ")}</Badge>
                          {profile?.mfaEnabled && (
                            <Badge variant="default" className="gap-1"><ShieldCheck className="h-3 w-3" /> MFA</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="name">Full Name</Label>
                        <Input id="name" {...register("name")} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="phone">Phone</Label>
                        <Input id="phone" {...register("phone")} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="language">Language</Label>
                        <Input id="language" placeholder="en" {...register("language")} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="timezone">Timezone</Label>
                        <Input id="timezone" placeholder="America/New_York" {...register("timezone")} />
                      </div>
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
        </TabsContent>

        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle>Recent Login Activity</CardTitle>
              <CardDescription>Your latest sign-in attempts across devices.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <Table>
                  <TableHeader className="bg-secondary/50">
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>IP Address</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!activity?.loginHistory?.length ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No activity recorded.</TableCell>
                      </TableRow>
                    ) : (
                      activity.loginHistory.map((e: LoginHistoryEntry) => (
                        <TableRow key={e.id}>
                          <TableCell>{fmt(e.createdAt)}</TableCell>
                          <TableCell className="font-mono text-xs">{e.ipAddress ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant={e.success ? "default" : "destructive"}>{e.success ? "Success" : "Failed"}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{e.reason ?? "—"}</TableCell>
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
