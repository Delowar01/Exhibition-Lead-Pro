import { config } from "../../config.js";

// B20 Correction 1 — TEST-ONLY fault injection for the billing seams (mirrors
// lib/workflows/dispatch.ts __setWorkflowDispatchFaultsForTests). Each hook is
// awaited at a named point of the orchestration so a suite can simulate a local
// persistence failure after a provider call, or hold two concurrent webhook
// deliveries at the same point (barrier). Hooks are inert unless set, are never
// settable in production, and are cleared by passing `{}`.

export type BillingFaultPoint =
  | "checkout.afterCustomerCreate" // provider customer exists remotely; local link not yet persisted
  | "checkout.afterSessionCreate" // provider session exists remotely; local link not yet persisted
  | "checkout.afterRecover" // recovery replay returned the remote session id; before the CAS persist
  | "checkout.beforeExpire" // just before asking the provider to expire an open session
  | "checkout.afterExpire" // provider confirmed the expiration; before the local transition
  | "webhook.beforeClaim" // signature verified + provider state fetched; before the durable claim
  | "webhook.beforeCommit"; // state applied inside the transaction; before commit

type Hook = () => void | Promise<void>;
const hooks = new Map<BillingFaultPoint, Hook>();

export function __setBillingFaultsForTests(faults: Partial<Record<BillingFaultPoint, Hook | null>>): void {
  if (config.nodeEnv === "production") return; // never available in production
  hooks.clear();
  for (const [k, v] of Object.entries(faults)) if (v) hooks.set(k as BillingFaultPoint, v);
}

export async function billingFault(point: BillingFaultPoint): Promise<void> {
  const h = hooks.get(point);
  if (h) await h();
}
