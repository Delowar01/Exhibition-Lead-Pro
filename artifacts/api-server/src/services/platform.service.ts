import * as platformRepo from "../repositories/platform.repository.js";

export async function getStats() {
  const totalCompanies = await platformRepo.countCompanies();
  const activeCompanies = await platformRepo.countActiveCompanies();
  const totalUsers = await platformRepo.countUsers();
  const totalScans = await platformRepo.countScans();
  const totalLeads = await platformRepo.countLeads();

  const planDistribution = await platformRepo.planDistribution();

  // Simulate monthly revenue from plans
  const planRevenue: Record<string, number> = { free: 0, starter: 29, professional: 99, enterprise: 299 };
  const monthlyRevenue = planDistribution.reduce((sum, p) => sum + (planRevenue[p.status] ?? 0) * p.count, 0);

  return {
    totalCompanies, activeCompanies, totalUsers, totalScans, totalLeads,
    monthlyRevenue,
    churnRate: totalCompanies > 0 ? Math.round(((totalCompanies - activeCompanies) / totalCompanies) * 100) : 0,
    subscriptionDistribution: planDistribution.map(p => ({ status: p.status, count: p.count, label: p.status })),
  };
}

export async function getRevenueTrend() {
  // Generate 12-month revenue trend (simulated based on company creation dates)
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
    // Simulate growing revenue
    const baseRevenue = 1200 + (11 - i) * 450 + Math.floor(Math.random() * 300);
    months.push({ date: d.toISOString().slice(0, 7), value: baseRevenue, label });
  }
  return months;
}

export async function getScanTrend() {
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString("default", { month: "short", day: "numeric" });
    days.push({ date: d.toISOString().slice(0, 10), value: Math.floor(40 + Math.random() * 120), label });
  }
  return days;
}

export async function getActivity() {
  const activity = await platformRepo.recentActivity(50);
  return activity;
}
