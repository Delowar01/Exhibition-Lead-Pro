import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Design-system theme switcher (light / dark / system). */
export function ThemeToggle({ variant = "default" }: { variant?: "default" | "sidebar" }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const Icon = resolvedTheme === "dark" ? Moon : Sun;
  const cls =
    variant === "sidebar"
      ? "flex items-center justify-center h-8 w-8 rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
      : "flex items-center justify-center h-8 w-8 rounded-md border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cls} aria-label={`Theme: ${theme}. Change theme`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onClick={() => setTheme(opt.value)}
            className={theme === opt.value ? "bg-accent text-accent-foreground" : ""}
          >
            <opt.icon className="h-4 w-4 mr-2" aria-hidden="true" />
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
