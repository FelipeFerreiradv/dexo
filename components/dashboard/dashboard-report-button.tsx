"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl, authHeaders } from "@/lib/api";
import {
  REPORT_PRESETS,
  resolveSelectedRange,
  type ReportPresetId,
} from "@/lib/report-period";

/** Ações do Dashboard: seletor de período (com personalizado) + relatório PDF. */
export function DashboardReportButton() {
  const { data: session } = useSession();
  const [preset, setPreset] = useState<ReportPresetId>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [downloading, setDownloading] = useState(false);

  const range = resolveSelectedRange(preset, customStart, customEnd);

  const handleDownload = async () => {
    if (!session?.user?.email || !range) return;
    setDownloading(true);
    try {
      const params = new URLSearchParams({
        startDate: range.start,
        endDate: range.end,
      });
      const res = await fetch(
        `${getApiBaseUrl()}/dashboard/report.pdf?${params.toString()}`,
        { headers: authHeaders(session) },
      );
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "relatorio-geral-dexo.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error("[DashboardReportButton] pdf error", err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={preset}
        onValueChange={(v) => setPreset(v as ReportPresetId)}
      >
        <SelectTrigger className="h-8 w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REPORT_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {preset === "custom" ? (
        <>
          <Input
            type="date"
            aria-label="Data inicial"
            value={customStart}
            max={customEnd || undefined}
            onChange={(e) => setCustomStart(e.target.value)}
            className="h-8 w-[140px] text-xs"
          />
          <Input
            type="date"
            aria-label="Data final"
            value={customEnd}
            min={customStart || undefined}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="h-8 w-[140px] text-xs"
          />
        </>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        onClick={handleDownload}
        disabled={downloading || !range}
      >
        <DownloadIcon className="mr-1.5 h-4 w-4" />
        {downloading ? "Gerando..." : "Relatório (PDF)"}
      </Button>
    </div>
  );
}
