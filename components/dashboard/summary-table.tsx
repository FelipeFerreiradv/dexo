"use client";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Tone = "positive" | "negative" | "warning" | "neutral";

export type SummaryTableRow = {
  title: string;
  section: string;
  status?: { label: string; tone: Tone };
  target?: string;
  limit?: string;
  owner?: string;
  meta?: string;
  delta?: string;
};

export type SummaryTableTab = {
  id: string;
  label: string;
  rows: SummaryTableRow[];
  emptyLabel: string;
};

const toneClasses: Record<Tone, string> = {
  positive:
    "border-primary/25 bg-primary/10 text-primary shadow-[0_1px_0] shadow-primary/10",
  negative:
    "border-destructive/30 bg-destructive/10 text-destructive shadow-[0_1px_0] shadow-destructive/10",
  warning:
    "border-accent/25 bg-accent/10 text-accent-foreground shadow-[0_1px_0] shadow-accent/10",
  neutral:
    "border-border/70 bg-muted/40 text-muted-foreground shadow-[0_1px_0] shadow-border/20",
};

function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        toneClasses[tone],
      )}
    >
      {label}
    </span>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/20 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

export function SummaryTable({ tabs }: { tabs: SummaryTableTab[] }) {
  const first = tabs[0]?.id;

  return (
    <div className="rounded-2xl border border-border/70 bg-card/80 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Operações
          </p>
          <h3 className="text-lg font-semibold tracking-tight text-foreground">
            Tarefas, integrações e produtos em foco
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-full border-border/70 bg-background"
          >
            Customizar colunas
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full">
            Exportar
          </Button>
        </div>
      </div>

      <Tabs defaultValue={first} className="mt-3">
        <div className="px-6 pb-2">
          <TabsList className="flex w-full justify-start gap-2 overflow-x-auto rounded-full border border-border/70 bg-muted/30 p-1">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className="rounded-full px-3 py-1.5 text-xs font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {tabs.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className="px-4 pb-5">
            {tab.rows.length === 0 ? (
              <EmptyState label={tab.emptyLabel} />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border/70 bg-background/40">
                <Table className="min-w-[720px]">
                  <TableHeader>
                    <TableRow className="border-border/70 text-xs uppercase tracking-[0.08em] text-muted-foreground">
                      <TableHead className="w-[26%]">Item</TableHead>
                      <TableHead className="w-[18%]">Tipo/SeÃ§Ã£o</TableHead>
                      <TableHead className="w-[14%]">Status</TableHead>
                      <TableHead className="w-[10%] text-right">Meta</TableHead>
                      <TableHead className="w-[10%] text-right">
                        Limite
                      </TableHead>
                      <TableHead className="w-[12%]">ResponsÃ¡vel</TableHead>
                      <TableHead className="w-[10%] text-right">
                        Delta
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tab.rows.map((row, idx) => (
                      <TableRow
                        key={`${tab.id}-${idx}`}
                        className="border-border/60 text-sm transition-colors hover:bg-muted/40"
                      >
                        <TableCell className="text-foreground">
                          <div className="flex flex-col gap-1">
                            <span className="font-medium leading-tight">
                              {row.title}
                            </span>
                            {row.meta ? (
                              <span className="text-xs text-muted-foreground">
                                {row.meta}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.section}
                        </TableCell>
                        <TableCell>
                          {row.status ? (
                            <StatusPill
                              label={row.status.label}
                              tone={row.status.tone}
                            />
                          ) : (
                            <StatusPill label="—" />
                          )}
                        </TableCell>
                        <TableCell className="text-right text-foreground">
                          {row.target ?? "—"}
                        </TableCell>
                        <TableCell className="text-right text-foreground">
                          {row.limit ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.owner ?? "—"}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {row.delta ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
