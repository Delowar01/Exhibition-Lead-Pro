import { Moon, Sun, Monitor, Building2, Check } from "lucide-react";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const LABEL: Record<ThemePreference, string> = { light: "Light", dark: "Dark", system: "System" };

/**
 * Design-system theme switcher (light / dark / system). Inside a tenant with a
 * default theme, "Organization default" follows that default; an explicit
 * choice always overrides it (Batch 18).
 */
export function ThemeToggle({ variant = "default" }: { variant?: "default" | "sidebar" }) {
  const { theme, preference, tenantDefault, resolvedTheme, setTheme, clearPreference } = useTheme();
  const Icon = resolvedTheme === "dark" ? Moon : Sun;
  const cls =
    variant === "sidebar"
      ? "flex items-center justify-center h-8 w-8 rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      : "flex items-center justify-center h-8 w-8 rounded-md border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const followingDefault = preference == null && tenantDefault != null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cls} aria-label={`Theme: ${theme}. Change theme`} data-testid="theme-toggle" data-theme-preference={preference ?? "default"}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map((opt) => {
          const active = preference === opt.value;
          return (
            <DropdownMenuItem key={opt.value} onClick={() => setTheme(opt.value)} className={active ? "bg-accent text-accent-foreground" : ""} data-testid={`theme-option-${opt.value}`}>
              <opt.icon className="h-4 w-4 me-2" aria-hidden="true" />
              {opt.label}
              {active && <Check className="h-3.5 w-3.5 ms-auto" aria-hidden="true" />}
            </DropdownMenuItem>
          );
        })}
        {tenantDefault && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={clearPreference} className={followingDefault ? "bg-accent text-accent-foreground" : ""} data-testid="theme-option-default">
              <Building2 className="h-4 w-4 me-2" aria-hidden="true" />
              Organization default ({LABEL[tenantDefault]})
              {followingDefault && <Check className="h-3.5 w-3.5 ms-auto" aria-hidden="true" />}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
