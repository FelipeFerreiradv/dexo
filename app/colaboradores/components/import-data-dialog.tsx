"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  CheckCircle2,
  Copy,
  FileUp,
  Loader2,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authHeaders, getApiBaseUrl } from "@/lib/api";

/* ------------------------------- Tipos --------------------------------- */

type ImportSystem = "VAAPT" | "WEBDESMONTE" | "DEXO" | "IBR" | "IBRSOFT";
type ImportEntity =
  | "CLIENTES"
  | "LOCALIZACOES"
  | "SUCATAS"
  | "VINCULOS"
  | "CONTAS"
  | "NFE"
  | "PACOTE"
  | "ESTOQUE";

interface RowIssue {
  linha?: number;
  motivo: string;
}

interface IgnoredFileInfo {
  arquivo: string;
  motivo: string;
}

interface ImportReport {
  dryRun: boolean;
  contadores: Record<string, number>;
  erros: RowIssue[];
  avisos: RowIssue[];
  amostra: Array<Record<string, unknown>>;
  /** Arquivos anexados que o motor NÃO usou. */
  ignorados?: IgnoredFileInfo[];
  semProduto?: { total: number; exemplos: string[] };
  ambiguos?: {
    total: number;
    exemplos: Array<{ sku: string; produtoIds: string[] }>;
  };
  porFase?: Record<string, ImportReport>;
}

interface PreviewResult {
  /** Sistema/entidade EFETIVOS (podem diferir do selecionado se auto-detectado). */
  system: ImportSystem;
  entity: ImportEntity;
  previewHash: string;
  arquivos: Array<{ campo: string; nome: string; linhas: number; tipo: string }>;
  dicas: string[];
  report: ImportReport;
}

interface JobStatus {
  jobId: string;
  status: "RUNNING" | "DONE" | "ERROR" | "INTERROMPIDO";
  progress: { fase: string; processadas: number; total: number };
  report?: ImportReport;
  error?: string;
}

interface AvailableEntity {
  system: ImportSystem;
  entity: ImportEntity;
}

/* ------------------------------- Rótulos -------------------------------- */

const SYSTEM_LABELS: Record<ImportSystem, string> = {
  VAAPT: "Vaapt (Vapt)",
  IBRSOFT: "IBR Soft (novo) — anexe TODOS os CSVs do export",
  WEBDESMONTE: "IBR clássico (WebDesmonte) — locations/products/customers.csv",
  IBR: "IBR tabular — anexe estoque.csv e/ou nfe_emitidas.csv (Pacote)",
  DEXO: "Template Dexo (CSV)",
};

const ENTITY_LABELS: Record<ImportEntity, string> = {
  CLIENTES: "Clientes",
  LOCALIZACOES: "Localizações",
  SUCATAS: "Sucatas (veículos)",
  VINCULOS: "Vínculo de produtos por SKU (localização + sucata)",
  CONTAS: "Contas a pagar / receber",
  NFE: "NF-e históricas",
  PACOTE: "Pacote completo (vários CSVs)",
  ESTOQUE: "Estoque (produtos + localização por SKU)",
};

const FILE_HINTS: Partial<Record<`${ImportSystem}/${ImportEntity}`, string>> = {
  "VAAPT/LOCALIZACOES":
    "Envie a planilha de peças (a que tem as colunas “# Cod Peca” e “Localizacao”).",
  "VAAPT/CLIENTES": "Envie a planilha de clientes (“# Cod Cliente”).",
  "VAAPT/SUCATAS":
    "Envie a planilha de veículos (“# Codigo Veiculo”) — nem todo pacote traz esse arquivo. Serve tanto o “Backup Veiculos” (com Marca/Modelo) quanto o “Veiculos<N>” (uma linha por foto); neste, sem Marca/Modelo, as sucatas ficam como INDEFINIDO e você as identifica pela placa/chassi.",
  "VAAPT/VINCULOS":
    "Envie a planilha de peças (“# Cod Peca” + “Localizacao” + “Cod Veiculo”).",
  "VAAPT/NFE": "Envie o resumo de notas emitidas (aba “Java Books”).",
  "VAAPT/PACOTE":
    "Envie as planilhas do export juntas: peças, clientes, veículos e notas emitidas (qualquer combinação). O sistema identifica cada arquivo pelas colunas e importa tudo na ordem certa — clientes → localizações → sucatas → vínculo por SKU → NF-e. O que ele não usar aparece listado no relatório (a planilha de FOTOS das peças, por exemplo, ainda não é importada).",
  "WEBDESMONTE/VINCULOS":
    "Envie products.csv E locations.csv juntos (o locations.csv resolve os vínculos).",
  "WEBDESMONTE/PACOTE":
    "Envie os CSVs do export juntos: locations, purchase_waste, products (e customers, se houver).",
  "WEBDESMONTE/SUCATAS":
    "Envie purchase_waste.csv (junte locations.csv para vincular a localização da sucata).",
  "DEXO/CONTAS":
    "CSV no template Dexo: tipo, documento, cliente_cpf_cnpj, cliente_nome, valor, vencimento, status, pago_em, forma_pagamento, parcelas, observacao.",
  "IBR/ESTOQUE":
    "Envie o estoque.csv (colunas SKU, QuantidadeEstoque, ValorVenda, LocalizacaoSiglas). Vincula a localização aos produtos existentes por SKU e cria os que faltam.",
  "IBR/NFE":
    "Envie o nfe_emitidas.csv (colunas NumeroNotaFiscal, ChaveDeAcesso, NomeDestinatario). Importa as notas como histórico, sem passar pela SEFAZ.",
  "IBR/PACOTE":
    "Anexe os CSVs do export tabular de uma vez (estoque.csv e/ou nfe_emitidas.csv). O sistema identifica cada arquivo pelas colunas, ignora os que não reconhecer (vendas, empresa…) e importa produtos e NF-e na ordem certa. Enviar só parte dos arquivos é permitido; reimportar não duplica.",
  "IBRSOFT/PACOTE":
    "Anexe TODOS os CSVs do export IBR Soft de uma vez (produtos, sucatas, localizacoes, costumers, nfe, contas_a_pagar, contas_a_receber). O sistema identifica cada arquivo pelas colunas, ignora os que não reconhecer e importa tudo na ordem certa. Reimportar não duplica.",
};

const ORDEM_RECOMENDADA =
  "Ordem recomendada: Clientes → Localizações → Sucatas → Vínculo de produtos → Contas → NF-e.";

/** Rótulos amigáveis para os contadores mais comuns dos relatórios. */
const COUNTER_LABELS: Record<string, string> = {
  linhas_no_arquivo: "linhas no arquivo",
  linhas_sem_localizacao: "linhas sem localização",
  localizacoes_distintas: "localizações distintas",
  localizacoes_no_plano: "localizações no plano",
  a_criar: "a criar",
  criadas: "criadas",
  criados: "criados",
  ja_existiam: "já existiam",
  erros: "erros",
  avisos: "avisos",
  linhas_repetidas_mesmo_veiculo: "linhas repetidas (mesmo veículo)",
};

function counterLabel(key: string): string {
  return COUNTER_LABELS[key] ?? key.replaceAll("_", " ");
}

/* ------------------------------ Componente ------------------------------ */

type Step = "config" | "preview" | "tracking" | "done";

interface ImportDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Admin-alvo: TODOS os dados serão criados no tenant dele. */
  targetUserId: string;
  targetLabel: string;
  targetEmail: string;
}

export function ImportDataDialog({
  open,
  onOpenChange,
  targetUserId,
  targetLabel,
  targetEmail,
}: ImportDataDialogProps) {
  const { data: session } = useSession();

  const [available, setAvailable] = useState<AvailableEntity[]>([]);
  const [system, setSystem] = useState<ImportSystem | "">("");
  const [entity, setEntity] = useState<ImportEntity | "">("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState<Step>("config");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [copied, setCopied] = useState(false);

  /* Combinações habilitadas no motor (novas entidades aparecem sozinhas). */
  useEffect(() => {
    if (!open || !session?.user?.email) return;
    void (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/superadmin/import/entities`, {
          headers: authHeaders(session),
        });
        const data = await res.json();
        if (res.ok && Array.isArray(data.entities)) {
          setAvailable(data.entities);
        }
      } catch {
        /* mantém lista vazia; o erro real aparece no preview */
      }
    })();
  }, [open, session]);

  const systems = useMemo(
    () =>
      (Object.keys(SYSTEM_LABELS) as ImportSystem[]).filter((s) =>
        available.some((a) => a.system === s),
      ),
    [available],
  );
  const entitiesForSystem = useMemo(
    () =>
      available
        .filter((a) => a.system === system)
        .map((a) => a.entity),
    [available, system],
  );

  const resetFlow = useCallback(() => {
    setStep("config");
    setPreview(null);
    setJob(null);
    setError(null);
    setBusy(false);
  }, []);

  const resetAll = useCallback(() => {
    resetFlow();
    setSystem("");
    setEntity("");
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [resetFlow]);

  const handleOpenChange = (o: boolean) => {
    if (!o) resetAll();
    onOpenChange(o);
  };

  /* Trocar sistema/entidade/arquivo invalida a prévia. */
  const onSystemChange = (v: string) => {
    setSystem(v as ImportSystem);
    setEntity("");
    resetFlow();
  };
  const onEntityChange = (v: string) => {
    setEntity(v as ImportEntity);
    resetFlow();
  };
  const onFilesChange = (list: FileList | null) => {
    setFiles(list ? Array.from(list) : []);
    resetFlow();
  };

  const buildFormData = useCallback(() => {
    const fd = new FormData();
    fd.append("targetUserId", targetUserId);
    fd.append("system", system);
    fd.append("entity", entity);
    for (const f of files) fd.append("file", f, f.name);
    return fd;
  }, [targetUserId, system, entity, files]);

  const handlePreview = async () => {
    if (!session?.user?.email || !system || !entity || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/superadmin/import/preview`, {
        method: "POST",
        headers: authHeaders(session),
        body: buildFormData(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Erro ao gerar a prévia");
      setPreview(data as PreviewResult);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao gerar a prévia");
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!session?.user?.email || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const fd = buildFormData();
      fd.append("previewHash", preview.previewHash);
      const res = await fetch(`${getApiBaseUrl()}/superadmin/import/apply`, {
        method: "POST",
        headers: authHeaders(session),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Erro ao aplicar a importação");
      setJob({
        jobId: data.jobId,
        status: "RUNNING",
        progress: { fase: "iniciando", processadas: 0, total: 0 },
      });
      setStep("tracking");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Erro ao aplicar a importação",
      );
      setStep("preview");
    } finally {
      setBusy(false);
    }
  };

  /* Polling de 2s enquanto o job roda (mesmo padrão das abas de sync). */
  useEffect(() => {
    if (step !== "tracking" || !job?.jobId || !session?.user?.email) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/superadmin/import/status/${job.jobId}`,
          { headers: authHeaders(session) },
        );
        const data = (await res.json()) as JobStatus;
        if (cancelled || !res.ok) return;
        setJob(data);
        if (data.status !== "RUNNING") setStep("done");
      } catch {
        /* falha transitória de rede — o próximo tick tenta de novo */
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [step, job?.jobId, session]);

  const handleCopyReport = async () => {
    const report = job?.report ?? preview?.report;
    if (!report) return;
    try {
      await navigator.clipboard?.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard indisponível — ignora */
    }
  };

  const fileHint = system && entity ? FILE_HINTS[`${system}/${entity}`] : null;
  const canPreview = !!system && !!entity && files.length > 0 && !busy;
  const pct =
    job && job.progress.total > 0
      ? Math.min(
          100,
          Math.round((job.progress.processadas / job.progress.total) * 100),
        )
      : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar dados do sistema antigo</DialogTitle>
          <DialogDescription>
            Os dados serão criados no tenant de <strong>{targetLabel}</strong> (
            {targetEmail}). Toda importação roda primeiro em prévia — nada é
            gravado antes da sua confirmação.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground">
            <FileUp className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{ORDEM_RECOMENDADA}</span>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Passo 1-2: origem + upload */}
          {(step === "config" || step === "preview") && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Sistema de origem</Label>
                  <Select value={system} onValueChange={onSystemChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione o sistema" />
                    </SelectTrigger>
                    <SelectContent>
                      {systems.map((s) => (
                        <SelectItem key={s} value={s}>
                          {SYSTEM_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Na dúvida, escolha qualquer um e anexe os arquivos: o sistema
                    reconhece o formato pelas colunas e se ajusta sozinho.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>O que importar</Label>
                  <Select
                    value={entity}
                    onValueChange={onEntityChange}
                    disabled={!system}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a entidade" />
                    </SelectTrigger>
                    <SelectContent>
                      {entitiesForSystem.map((e) => (
                        <SelectItem key={e} value={e}>
                          {ENTITY_LABELS[e]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="import-files">
                  Arquivo(s) — .csv, .xlsx ou .xls (até 20MB cada)
                </Label>
                <Input
                  id="import-files"
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".csv,.xlsx,.xls"
                  onChange={(e) => onFilesChange(e.target.files)}
                />
                {fileHint && (
                  <p className="text-xs text-muted-foreground">{fileHint}</p>
                )}
              </div>
            </div>
          )}

          {/* Passo 3: prévia */}
          {step === "preview" && preview && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Prévia (nada foi gravado)</span>
                <Badge variant="secondary">dry-run</Badge>
              </div>

              {preview.system && SYSTEM_LABELS[preview.system] && (
                <div className="text-xs text-muted-foreground">
                  Importando como:{" "}
                  <span className="font-medium text-foreground">
                    {SYSTEM_LABELS[preview.system]}
                  </span>{" "}
                  · {ENTITY_LABELS[preview.entity] ?? preview.entity}
                </div>
              )}

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {preview.arquivos.map((a) => (
                  <span key={a.campo + a.nome} className="rounded bg-muted px-2 py-1">
                    {a.nome} · {a.linhas} linhas
                  </span>
                ))}
              </div>

              <ReportView report={preview.report} />

              <ul className="space-y-1 text-xs text-muted-foreground">
                {preview.dicas.map((d) => (
                  <li key={d}>• {d}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Passo 5: progresso */}
          {step === "tracking" && job && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Importando… fase: {job.progress.fase} (
                {job.progress.processadas}/{job.progress.total || "?"})
              </div>
              <Progress value={pct} />
            </div>
          )}

          {/* Passo 6: relatório final */}
          {step === "done" && job && (
            <div className="space-y-3 rounded-md border p-3">
              {job.status === "DONE" && (
                <div className="flex items-center gap-2 text-sm text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                  Importação concluída.
                </div>
              )}
              {job.status === "ERROR" && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <TriangleAlert className="h-4 w-4" />
                  A importação falhou: {job.error ?? "erro desconhecido"}
                </div>
              )}
              {job.status === "INTERROMPIDO" && (
                <div className="flex items-center gap-2 text-sm text-amber-600">
                  <TriangleAlert className="h-4 w-4" />
                  A importação foi interrompida (o servidor reiniciou).
                  Re-executar é seguro: a importação é idempotente.
                </div>
              )}
              {job.report && <ReportView report={job.report} />}
            </div>
          )}
        </div>

        <DialogFooter>
          {step === "config" && (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancelar
              </Button>
              <Button onClick={handlePreview} disabled={!canPreview}>
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Gerando prévia…
                  </>
                ) : (
                  "Gerar prévia"
                )}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={resetFlow} disabled={busy}>
                Voltar
              </Button>
              <Button onClick={handleApply} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Aplicando…
                  </>
                ) : (
                  `Confirmar importação para ${targetEmail}`
                )}
              </Button>
            </>
          )}
          {step === "tracking" && (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Fechar (a importação continua no servidor)
            </Button>
          )}
          {step === "done" && (
            <>
              <Button variant="outline" onClick={handleCopyReport}>
                {copied ? (
                  <>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Copiado
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-4 w-4" />
                    Copiar relatório (JSON)
                  </>
                )}
              </Button>
              <Button onClick={() => handleOpenChange(false)}>Concluir</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- Render do relatório ------------------------ */

function ReportView({ report }: { report: ImportReport }) {
  const fases = report.porFase ? Object.entries(report.porFase) : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {Object.entries(report.contadores).map(([k, v]) => (
          <Badge
            key={k}
            variant={
              k === "erros" && v > 0
                ? "destructive"
                : k === "criadas" || k === "criados" || k === "a_criar"
                  ? "default"
                  : "outline"
            }
          >
            {counterLabel(k)}: {v}
          </Badge>
        ))}
      </div>

      {report.ignorados && report.ignorados.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <TriangleAlert className="h-3.5 w-3.5" />
            {report.ignorados.length} arquivo(s) anexado(s) NÃO foram importados
          </div>
          <ul className="max-h-24 space-y-0.5 overflow-y-auto">
            {report.ignorados.map((i) => (
              <li key={i.arquivo}>
                <span className="font-medium">{i.arquivo}</span> — {i.motivo}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.semProduto && report.semProduto.total > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <TriangleAlert className="h-3.5 w-3.5" />
            {report.semProduto.total} SKU(s) sem produto correspondente — serão
            pulados (nunca vinculados a outro produto)
          </div>
          <div className="max-h-24 overflow-y-auto break-all">
            {report.semProduto.exemplos.join(", ")}
            {report.semProduto.total > report.semProduto.exemplos.length &&
              ` … (+${report.semProduto.total - report.semProduto.exemplos.length})`}
          </div>
        </div>
      )}

      {report.ambiguos && report.ambiguos.total > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <TriangleAlert className="h-3.5 w-3.5" />
            {report.ambiguos.total} SKU(s) ambíguos (casam mais de um produto) —
            não serão vinculados
          </div>
          <div className="max-h-24 overflow-y-auto break-all">
            {report.ambiguos.exemplos.map((a) => a.sku).join(", ")}
          </div>
        </div>
      )}

      {report.avisos.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {report.contadores.avisos ?? report.avisos.length} aviso(s)
          </summary>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
            {report.avisos.map((a, i) => (
              <li key={i}>
                {a.linha != null ? `linha ${a.linha}: ` : ""}
                {a.motivo}
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.erros.length > 0 && (
        <details className="text-xs text-destructive">
          <summary className="cursor-pointer">
            {report.contadores.erros ?? report.erros.length} erro(s) de linha
          </summary>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
            {report.erros.map((e, i) => (
              <li key={i}>
                {e.linha != null ? `linha ${e.linha}: ` : ""}
                {e.motivo}
              </li>
            ))}
          </ul>
        </details>
      )}

      {fases && fases.length > 0 && (
        <div className="space-y-2">
          {fases.map(([nome, sub]) => (
            <div key={nome} className="rounded-md border p-2">
              <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                {nome}
              </div>
              <ReportView report={sub} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
