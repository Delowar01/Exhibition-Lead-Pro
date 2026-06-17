import React from "react";
import { useParams, useLocation } from "wouter";
import { useGetLead, useUpdateLead, LeadStage, getGetLeadQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { 
  Building2, Mail, Phone, ArrowLeft, MoreHorizontal, Calendar as CalendarIcon, 
  MapPin, Globe, Linkedin, FileText, CheckCircle2, Clock, Sparkles, Send, CalendarPlus,
  Contact
} from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function AdminLeadDetail() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const id = params.id ? parseInt(params.id, 10) : 0;
  
  const { data: lead, isLoading } = useGetLead(id, { 
    query: { enabled: !!id, queryKey: getGetLeadQueryKey(id) } 
  });
  const updateLead = useUpdateLead();

  if (isLoading) {
    return <div className="p-8 flex justify-center">Loading lead details...</div>;
  }

  if (!lead) {
    return <div className="p-8 flex justify-center">Lead not found</div>;
  }

  const handleStageChange = (newStage: LeadStage) => {
    updateLead.mutate(
      { id, data: { stage: newStage } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
          toast({ title: "Lead stage updated" });
        }
      }
    );
  };

  const formatStage = (stage: string) => stage.replace("_", " ");

  // AI Score Mock Data
  const scoreData = [
    { name: 'Profile Fit', value: 25, fill: 'hsl(var(--primary))' },
    { name: 'Engagement', value: 20, fill: 'hsl(var(--chart-2))' },
    { name: 'Activity', value: 20, fill: 'hsl(var(--chart-3))' },
    { name: 'Intent', value: 20, fill: 'hsl(var(--chart-4))' },
  ];
  const totalScore = 85;

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => setLocation('/admin/leads')} className="rounded-full">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{lead.contactName || "Unnamed Lead"}</h1>
            <Badge className="bg-primary/20 text-primary hover:bg-primary/30 border-none px-2.5 py-0.5 text-sm font-bold">
              Score: {totalScore}
            </Badge>
            <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50">High Priority</Badge>
          </div>
          <div className="text-muted-foreground mt-1 flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4" />
            <span>{lead.contactCompany || "No Company"}</span>
            <span className="text-border">•</span>
            <span>Created {format(new Date(lead.createdAt), 'MMM d, yyyy')}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="border-green-200 text-green-600 hover:bg-green-50 hover:text-green-700 bg-green-50/50">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-5 w-5">
              <path d="M12.0001 2.40002C6.69614 2.40002 2.40015 6.69602 2.40015 12C2.40015 14.1085 3.08051 16.0594 4.22591 17.6598L3.10915 21.0543L6.65751 19.9806C8.21203 21.0003 10.0465 21.6 12.0001 21.6C17.3041 21.6 21.6001 17.304 21.6001 12C21.6001 6.69602 17.3041 2.40002 12.0001 2.40002ZM17.433 16.3263C17.1895 17.0142 16.2307 17.5647 15.4674 17.7262C14.9351 17.8385 14.237 17.9255 11.6441 16.8504C8.32422 15.4741 6.1856 12.0838 6.02705 11.8741C5.86851 11.6644 4.70881 10.1256 4.70881 8.53321C4.70881 6.94084 5.51862 6.16629 5.86241 5.81643C6.14371 5.53001 6.61111 5.40578 7.05417 5.40578C7.19502 5.40578 7.32357 5.41217 7.43857 5.41829C7.77708 5.4367 7.94632 5.45869 8.16853 5.99266C8.44372 6.65487 9.11545 8.29749 9.19479 8.46083C9.27413 8.62417 9.38006 8.84577 9.27413 9.05581C9.1682 9.26584 9.06249 9.35926 8.90394 9.54589C8.7454 9.73253 8.59218 9.87834 8.43363 10.0884C8.28564 10.2869 8.12151 10.4965 8.30132 10.8055C8.48113 11.1145 9.1102 12.1466 10.0308 12.9669C11.218 14.0249 12.1906 14.3644 12.5292 14.5043C12.7937 14.6142 13.1112 14.5908 13.3121 14.3694C13.5661 14.0895 13.8833 13.6111 14.2113 13.1444C14.4441 13.8117 14.7397 14.0202 15.0136 14.1132C15.2875 14.2062 16.7419 14.9295 17.0329 15.0694C17.3239 15.2093 17.5143 15.2793 17.5884 15.3959C17.6624 15.5125 17.6624 16.0368 17.433 16.3263Z" fill="currentColor"/>
            </svg>
          </Button>
          <Button variant="outline" size="icon"><Phone className="h-4 w-4" /></Button>
          <Button variant="outline" size="icon"><Mail className="h-4 w-4" /></Button>
          <Button variant="outline" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
          <div className="h-8 w-px bg-border mx-1"></div>
          <Button onClick={() => handleStageChange('won' as any)} className="bg-green-600 hover:bg-green-700 text-white">
            Mark as Won
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Pipeline Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between relative">
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-secondary rounded-full -z-10"></div>
                {Object.values(LeadStage).map((stage, index) => {
                  const stages = Object.values(LeadStage);
                  const currentIndex = stages.indexOf(lead.stage as any);
                  const isPast = index <= currentIndex;
                  const isCurrent = index === currentIndex;
                  
                  return (
                    <div key={stage} className="flex flex-col items-center gap-2 bg-card px-2">
                      <button 
                        onClick={() => handleStageChange(stage as any)}
                        className={`w-6 h-6 rounded-full flex items-center justify-center border-2 transition-colors ${
                          isCurrent ? 'border-primary bg-primary text-primary-foreground' : 
                          isPast ? 'border-primary bg-primary/20 text-primary' : 
                          'border-border bg-background text-muted-foreground'
                        }`}
                      >
                        {isPast && !isCurrent ? <CheckCircle2 className="h-4 w-4" /> : <div className="w-2 h-2 rounded-full bg-current" />}
                      </button>
                      <span className={`text-[10px] font-medium uppercase tracking-wider ${isCurrent ? 'text-primary' : 'text-muted-foreground'}`}>
                        {formatStage(stage)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Tabs defaultValue="overview" className="w-full">
            <TabsList className="w-full justify-start border-b border-border rounded-none h-auto p-0 bg-transparent mb-6">
              <TabsTrigger value="overview" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3">Overview</TabsTrigger>
              <TabsTrigger value="notes" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3">Notes</TabsTrigger>
              <TabsTrigger value="activities" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3">Activities</TabsTrigger>
              <TabsTrigger value="tasks" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3">Tasks</TabsTrigger>
            </TabsList>
            
            <TabsContent value="overview" className="space-y-6 mt-0">
              <div className="grid grid-cols-2 gap-6">
                <Card className="shadow-sm border-border/50">
                  <CardHeader className="pb-3 bg-secondary/30">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Contact className="h-4 w-4 text-primary" /> Contact Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-4">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1">Email</p>
                      <p className="text-sm font-medium">{lead.contactEmail || "jane.doe@example.com"}</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1">Phone</p>
                      <p className="text-sm font-medium">+1 (555) 123-4567</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1">Job Title</p>
                      <p className="text-sm font-medium">VP of Operations</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1">LinkedIn</p>
                      <a href="#" className="text-sm font-medium text-blue-600 hover:underline flex items-center gap-1">
                        <Linkedin className="h-3 w-3" /> linkedin.com/in/janedoe
                      </a>
                    </div>
                  </CardContent>
                </Card>

                <Card className="shadow-sm border-border/50">
                  <CardHeader className="pb-3 bg-secondary/30">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-primary" /> Company Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-4">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1">Company</p>
                      <p className="text-sm font-medium">{lead.contactCompany || "Acme Corp"}</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1">Industry</p>
                      <p className="text-sm font-medium">Software Development</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1">Website</p>
                      <a href="#" className="text-sm font-medium text-blue-600 hover:underline flex items-center gap-1">
                        <Globe className="h-3 w-3" /> acmecorp.com
                      </a>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1">Location</p>
                      <p className="text-sm font-medium flex items-center gap-1">
                        <MapPin className="h-3 w-3 text-muted-foreground" /> San Francisco, CA
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle className="text-lg">Lead Timeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="relative pl-6 border-l border-border space-y-6">
                    <div className="relative">
                      <div className="absolute -left-[31px] bg-primary p-1 rounded-full border-4 border-card">
                        <Mail className="h-3 w-3 text-primary-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Follow-up email sent</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Today at 10:30 AM</p>
                        <div className="mt-2 text-sm bg-secondary/50 p-3 rounded-md border border-border">
                          "Hi Jane, it was great meeting you at the expo. I'd love to schedule a quick call to discuss how we can help Acme Corp..."
                        </div>
                      </div>
                    </div>
                    <div className="relative">
                      <div className="absolute -left-[31px] bg-chart-2 p-1 rounded-full border-4 border-card">
                        <CheckCircle2 className="h-3 w-3 text-white" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Stage changed to Proposal Sent</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Yesterday at 4:15 PM</p>
                      </div>
                    </div>
                    <div className="relative">
                      <div className="absolute -left-[31px] bg-chart-4 p-1 rounded-full border-4 border-card">
                        <CalendarIcon className="h-3 w-3 text-white" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Lead captured via Business Card Scan</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Oct 12, 2023 at Tech Expo SF</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="notes">
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground">
                  Notes panel coming soon...
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="activities">
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground">
                  Activities panel coming soon...
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="tasks">
              <Card>
                <CardContent className="p-6 text-center text-muted-foreground">
                  Tasks panel coming soon...
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-6">
          {/* AI Insights Panel */}
          <Card className="shadow-sm border-primary/20 bg-gradient-to-b from-primary/5 to-background">
            <CardHeader className="pb-3 border-b border-primary/10">
              <CardTitle className="text-base flex items-center gap-2 text-primary">
                <Sparkles className="h-4 w-4" /> AI Insights
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Summary</p>
                <p className="text-sm leading-relaxed">
                  High-intent lead. Jane expressed strong interest in our automation tools during the Tech Expo. Her company is actively looking to replace their legacy CRM within Q4.
                </p>
              </div>
              
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Interests</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="bg-white dark:bg-black text-xs font-normal">API Integration</Badge>
                  <Badge variant="secondary" className="bg-white dark:bg-black text-xs font-normal">Team Collaboration</Badge>
                  <Badge variant="secondary" className="bg-white dark:bg-black text-xs font-normal">Analytics</Badge>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Pain Points</p>
                <ul className="text-sm space-y-1">
                  <li className="flex items-start gap-2">
                    <div className="w-1 h-1 rounded-full bg-destructive mt-1.5 flex-shrink-0" />
                    <span>Data silos between sales and marketing</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <div className="w-1 h-1 rounded-full bg-destructive mt-1.5 flex-shrink-0" />
                    <span>Manual data entry taking too much time</span>
                  </li>
                </ul>
              </div>

              <div className="bg-white dark:bg-black rounded-lg p-3 border border-primary/20 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-1">Recommended Action</p>
                <p className="text-sm font-medium">Send case study on API Integrations and schedule a technical demo.</p>
              </div>
            </CardContent>
          </Card>

          {/* Lead Score Breakdown */}
          <Card className="shadow-sm">
            <CardHeader className="pb-0">
              <CardTitle className="text-base">Lead Score Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center pb-2">
              <div className="h-[180px] w-full relative mt-2">
                <div className="absolute inset-0 flex items-center justify-center flex-col">
                  <span className="text-4xl font-bold">{totalScore}</span>
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest mt-1">Excellent</span>
                </div>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={scoreData}
                      cx="50%"
                      cy="50%"
                      innerRadius={65}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                      stroke="none"
                    >
                      {scoreData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      formatter={(value: number) => [`${value} pts`, 'Score']}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', fontSize: '12px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="w-full grid grid-cols-2 gap-x-2 gap-y-3 mt-4">
                {scoreData.map(item => (
                  <div key={item.name} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: item.fill }}></div>
                    <span className="text-xs font-medium text-muted-foreground flex-1">{item.name}</span>
                    <span className="text-xs font-bold">{item.value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Action Cards */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b border-border mb-3">
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" className="w-full justify-start h-auto py-3 px-4 border-border hover:bg-secondary/50 hover:border-primary/50 transition-colors">
                <Send className="h-4 w-4 mr-3 text-muted-foreground" />
                <div className="text-left">
                  <div className="text-sm font-medium">Send Email Template</div>
                  <div className="text-xs text-muted-foreground">Select from saved templates</div>
                </div>
              </Button>
              <Button variant="outline" className="w-full justify-start h-auto py-3 px-4 border-border hover:bg-secondary/50 hover:border-primary/50 transition-colors">
                <CalendarPlus className="h-4 w-4 mr-3 text-muted-foreground" />
                <div className="text-left">
                  <div className="text-sm font-medium">Schedule Meeting</div>
                  <div className="text-xs text-muted-foreground">Send calendar booking link</div>
                </div>
              </Button>
              <Button variant="outline" className="w-full justify-start h-auto py-3 px-4 border-border hover:bg-secondary/50 hover:border-primary/50 transition-colors">
                <FileText className="h-4 w-4 mr-3 text-muted-foreground" />
                <div className="text-left">
                  <div className="text-sm font-medium">Generate Proposal</div>
                  <div className="text-xs text-muted-foreground">Create draft from lead data</div>
                </div>
              </Button>
            </CardContent>
          </Card>
          
          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b border-border mb-3">
              <CardTitle className="text-base flex justify-between items-center">
                Tags
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">Edit</Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary" className="font-normal text-xs bg-blue-100 text-blue-800 hover:bg-blue-100">Enterprise</Badge>
                <Badge variant="secondary" className="font-normal text-xs bg-purple-100 text-purple-800 hover:bg-purple-100">Q4 Target</Badge>
                <Badge variant="secondary" className="font-normal text-xs bg-orange-100 text-orange-800 hover:bg-orange-100">Tech Expo</Badge>
                <Badge variant="secondary" className="font-normal text-xs bg-gray-100 text-gray-800 hover:bg-gray-100">Decision Maker</Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
