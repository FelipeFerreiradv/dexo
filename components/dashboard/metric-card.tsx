import { ArrowDownRight, ArrowUpRight, LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type MetricTone = "positive" | "negative" | "neutral";

interface MetricCardProps {
  title: string;
  value: string;
  caption?: string;
  delta?: number | null;
  deltaLabel?: string;
  icon?: LucideIcon;
  tone?: MetricTone;
  accentLabel?: string;
  className?: string;
}

function formatDelta(delta?: number | null) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) {
    return "—";
  }
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

export function MetricCard({
  title,
  value,
  caption,
  delta,
  deltaLabel = "vs. período anterior",
  icon: Icon,
  tone = "neutral",
  accentLabel,
  className,
}: MetricCardProps) {
  const DeltaIcon =
    delta !== undefined && delta !== null && delta < 0
      ? ArrowDownRight
      : ArrowUpRight;

  const deltaTone =
    delta === null || delta === undefined
      ? "bg-muted/50 text-muted-foreground border-border/60"
      : delta >= 0
        ? "bg-primary/12 text-primary border-primary/30"
        : "bg-destructive/12 text-destructive border-destructive/30";

  const halo =
    tone === "positive"
      ? "from-primary/18 via-primary/0"
      : tone === "negative"
        ? "from-destructive/18 via-destructive/0"
        : "from-accent/16 via-accent/0";

  return (
    <Card
      className={cn(
        "group relative overflow-hidden border border-border/60 bg-card/90 shadow-[0_12px_40px_color-mix(in_srgb,var(--color-shadow-color)_8%,transparent)] backdrop-blur supports-[backdrop-filter]:bg-card/80 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/30",
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100",
          halo,
        )}
      />
      <CardHeader className="flex flex-row items-start justify-between gap-3 px-5 pb-2 pt-4">
        <div className="space-y-1.5">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
            {title}
          </CardTitle>
          {accentLabel ? (
            <CardDescription className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground">
              {accentLabel}
            </CardDescription>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <div
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]",
              deltaTone,
            )}
          >
            <DeltaIcon className="size-3" />
            <span>{formatDelta(delta)}</span>
          </div>
          {deltaLabel ? (
            <span className="text-[10px] text-muted-foreground">
              {deltaLabel}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-3xl font-semibold leading-none tracking-tight text-foreground">
            {value}
          </span>
          {Icon ? (
            <div className="flex size-11 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground shadow-inner shadow-[0_1px_2px_color-mix(in_srgb,var(--color-shadow-color)_12%,transparent)]">
              <Icon className="size-5" />
            </div>
          ) : null}
        </div>
        {caption ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {caption}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
