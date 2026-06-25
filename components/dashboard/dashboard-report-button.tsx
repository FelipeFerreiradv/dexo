"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl, authHeaders } from "@/lib/api";

type PresetId = "today" | "7d" | "30d" | "month";

const PRESETS: { id: PresetId; label: string }[] = [
  { id: "today", label: "Hoje" },
  { id: "7d", label: "Últimos 7 dias" },
  { id: "30d", label: "Últimos 30 dias" },
  { id: "month", label: "Este mês" },
];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetRange(id: PresetId): { start: string; end: string } {
  const now = new Date();
  const end = ymd(now);
  if (id === "today") return { start: end, end };
  if (id === "7d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    return { start: ymd(s), end };
  }
  if (id === "month") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: ymd(s), end };
  }
  const s = new Date(now);
  s.setDate(s.getDate() - 29);
  return { start: ymd(s), end };
}

/** Ações do Dashboard: seletor de período + geração do relatório PDF (Entrega C). */
export function DashboardReportButton() {
  const { data: session } = useSession();
  const [preset, setPreset] = useState<PresetId>("30d");
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!session?.user?.email) return;
    setDownloading(true);
    try {
      const { start, end } = presetRange(preset);
      const params = new URLSearchParams({ startDate: start, endDate: end });
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
    <div className="flex items-center gap-2">
      <Select value={preset} onValueChange={(v) => setPreset(v as PresetId)}>
        <SelectTrigger className="h-8 w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        onClick={handleDownload}
        disabled={downloading}
      >
        <DownloadIcon className="mr-1.5 h-4 w-4" />
        {downloading ? "Gerando..." : "Relatório (PDF)"}
      </Button>
    </div>
  );
}
