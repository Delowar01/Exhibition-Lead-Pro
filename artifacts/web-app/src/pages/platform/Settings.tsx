import { PageHeader } from "@/components/ds";
import { AiProvidersSettings } from "@/components/platform/AiProvidersSettings";

// Platform Owner → Settings. Platform-wide configuration that takes effect without a
// deployment. Each area is its own section; AI Providers is the first.
export default function PlatformSettings() {
  return (
    <div>
      <PageHeader title="Settings" description="Platform-wide configuration. Changes here apply to every company." />
      <AiProvidersSettings />
    </div>
  );
}
