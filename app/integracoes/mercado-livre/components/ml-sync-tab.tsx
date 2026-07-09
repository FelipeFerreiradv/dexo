"use client";

import { useState, useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import {
  Download,
  Upload,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Package,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface ImportItem {
  externalListingId: string;
  title: string;
  sku: string | null;
  linkedProductId: string | null;
  status: string;
}

interface ImportResult {
  success?: boolean;
  totalItems: number;
  linkedItems: number;
  unlinkedItems: number;
  createdProducts?: number;
  alreadyLinked?: number;
  skippedDuplicates?: number;
  accountsProcessed?: number;
  errorCount?: number;
  items: ImportItem[];
  errors: string[];
  message?: string;
}

interface ImportProgress {
  state: "running" | "completed" | "failed";
  accountsTotal: number;
  accountsDone: number;
  processedItems: number;
  startedAt: string;
  finishedAt?: string;
  message?: string;
}

interface ImportJobStartResponse {
  success: boolean;
  importId: string;
  status: "running" | "completed" | "failed";
  message: string;
}

interface ImportJobStatusResponse {
  success: boolean;
  importId: string;
  status: "running" | "completed" | "failed";
  progress: ImportProgress;
  result?: ImportResult;
}

interface SyncResult {
  productId: string;
  externalListingId: string;
  success: boolean;
  previousStock?: number;
  newStock?: number;
  error?: string;
}

interface SyncResponse {
  success: boolean;
  total: number;
  successful: number;
  failed: number;
  results: SyncResult[];
  message?: string;
}

export function MLSyncTab() {
  const { data: session } = useSession();
  const [isImporting, setIsImporting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<
    ImportJobStatusResponse["status"] | null
  >(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(
    null,
  );
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{ id: string; accountName: string }>
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");

  // Consulta o status do job de importação (cria+vincula) e atualiza a UI.
  const pollImportStatus = useCallback(
    async (jobId: string) => {
      if (!session?.user?.email) return;

      const response = await fetch(
        `${getApiBaseUrl()}/marketplace/ml/import/${jobId}`,
        { headers: { email: session.user.email } },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Erro ao consultar importação");
      }

      const statusData = data as ImportJobStatusResponse;
      setImportStatus(statusData.status);
      setImportProgress(statusData.progress);
      if (statusData.result) setImportResult(statusData.result);

      if (statusData.status === "completed") {
        setIsImporting(false);
        setImportJobId(null);
        return;
      }
      if (statusData.status === "failed") {
        setIsImporting(false);
        setImportJobId(null);
        setError(
          statusData.progress?.message ||
            statusData.result?.errors?.[0] ||
            "Erro ao importar anúncios do Mercado Livre",
        );
      }
    },
    [session?.user?.email],
  );

  // Importar itens do ML (job assíncrono multi-conta + polling)
  const handleImport = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsImporting(true);
    setError(null);
    setImportResult(null);
    setImportJobId(null);
    setImportStatus(null);
    setImportProgress(null);

    try {
      const url = new URL(`${getApiBaseUrl()}/marketplace/ml/import`);
      if (selectedAccountId)
        url.searchParams.set("accountId", selectedAccountId);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          email: session.user.email,
        },
      });

      const data = (await response.json()) as ImportJobStartResponse;
      if (!response.ok && response.status !== 202) {
        throw new Error(data.message || "Erro ao importar itens");
      }

      setImportJobId(data.importId);
      setImportStatus(data.status);
      setImportProgress({
        state: data.status,
        accountsTotal: 0,
        accountsDone: 0,
        processedItems: 0,
        startedAt: new Date().toISOString(),
        message: data.message,
      });
    } catch (err) {
      setImportJobId(null);
      setImportStatus(null);
      setError(err instanceof Error ? err.message : "Erro ao importar");
      setIsImporting(false);
    }
  }, [session?.user?.email, selectedAccountId]);

  // Sincronizar estoque para o ML
  const handleSync = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsSyncing(true);
    setError(null);
    setSyncResult(null);

    try {
      const url = new URL(`${getApiBaseUrl()}/marketplace/ml/sync`);
      if (selectedAccountId)
        url.searchParams.set("accountId", selectedAccountId);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          email: session.user.email,
        },
      });

      if (!response.ok && response.status !== 202) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao sincronizar estoque");
      }

      const data = await response.json();

      // 202 = sync rodando em background
      if (response.status === 202) {
        setSyncResult({
          success: true,
          total: 0,
          successful: 0,
          failed: 0,
          results: [],
          message:
            data.message ||
            "Sincronização iniciada em segundo plano. Aguarde alguns instantes e recarregue a página.",
        } as SyncResponse);
      } else {
        setSyncResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao sincronizar");
    } finally {
      setIsSyncing(false);
    }
  }, [session?.user?.email, selectedAccountId]);

  // Carrega contas para permitir seleção de qual conta sincronizar/importar
  useEffect(() => {
    const loadAccounts = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(`${getApiBaseUrl()}/marketplace/ml/accounts`, {
          headers: { email: session.user.email },
        });
        if (res.ok) {
          const data = await res.json();
          setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
        }
      } catch {
        /* silenciosamente */
      }
    };
    loadAccounts();
  }, [session?.user?.email]);

  // Polling do job de importação (a cada 2s enquanto estiver rodando)
  useEffect(() => {
    if (!importJobId || !isImporting) return;

    let cancelled = false;
    const runPoll = async () => {
      if (cancelled) return;
      try {
        await pollImportStatus(importJobId);
      } catch (err) {
        if (cancelled) return;
        setImportJobId(null);
        setImportStatus(null);
        setIsImporting(false);
        setError(
          err instanceof Error ? err.message : "Erro ao consultar importação",
        );
      }
    };

    void runPoll();
    const intervalId = window.setInterval(() => {
      void runPoll();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [importJobId, isImporting, pollImportStatus]);

  // Forçar retry imediato de placeholders pendentes
  const handleRetryPending = useCallback(async () => {
    if (!session?.user?.email) return;
    setError(null);

    try {
      const res = await fetch(
        `${getApiBaseUrl()}/marketplace/ml/retry-pending`,
        {
          method: "POST",
          headers: { email: session.user.email },
        },
      );
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message || "Erro ao iniciar retry");
      }
      // not much to show immediately — background worker will run
      setSyncResult((s) => s ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao iniciar retry");
    }
  }, [session?.user?.email]);

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Card de Importação */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Importar Anúncios
          </CardTitle>
          <CardDescription>
            Busca seus anúncios no Mercado Livre e tenta vincular
            automaticamente aos produtos do seu estoque através do SKU.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded border px-2 py-1 text-sm"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
            >
              <option value="">Todas as contas</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.accountName || acc.id}
                </option>
              ))}
            </select>

            <Button onClick={handleImport} disabled={isImporting}>
              {isImporting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Importando...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Importar anúncios
                </>
              )}
            </Button>

            <Button variant="outline" onClick={handleRetryPending}>
              <Upload className="mr-2 h-4 w-4" />
              Re-tentar anúncios pendentes
            </Button>
          </div>

          {/* Progresso enquanto o job roda */}
          {isImporting && (
            <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {importProgress?.message ||
                  "Importando anúncios em segundo plano…"}
                {importProgress && importProgress.accountsTotal > 1
                  ? ` (conta ${importProgress.accountsDone}/${importProgress.accountsTotal})`
                  : ""}
              </span>
            </div>
          )}

          {/* Resultado da importação */}
          {importResult && (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                <span className="font-medium">
                  {importResult.message ||
                    `Importação concluída: ${importResult.createdProducts ?? 0} produto(s) criado(s), ${importResult.linkedItems} vinculado(s)`}
                </span>
              </div>

              {!importResult.message && (
              <div className="grid grid-cols-2 gap-4 text-center sm:grid-cols-4">
                <div className="rounded-md bg-muted p-3">
                  <div className="text-2xl font-bold">
                    {importResult.totalItems}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Total de itens
                  </div>
                </div>
                <div className="rounded-md bg-blue-100 p-3 dark:bg-blue-900/20">
                  <div className="text-2xl font-bold text-blue-700 dark:text-blue-400">
                    {importResult.createdProducts ?? 0}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Produtos criados
                  </div>
                </div>
                <div className="rounded-md bg-green-100 p-3 dark:bg-green-900/20">
                  <div className="text-2xl font-bold text-green-700 dark:text-green-400">
                    {importResult.linkedItems}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Vinculados
                  </div>
                </div>
                <div className="rounded-md bg-yellow-100 p-3 dark:bg-yellow-900/20">
                  <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-400">
                    {importResult.unlinkedItems}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Não vinculados
                  </div>
                </div>
              </div>
              )}

              {/* Lista de itens importados */}
              {!importResult.message && importResult.items.length > 0 && (
                <Accordion type="single" collapsible className="w-full">
                  <AccordionItem value="items">
                    <AccordionTrigger className="text-sm">
                      Ver detalhes ({importResult.items.length} itens)
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="max-h-60 space-y-2 overflow-y-auto">
                        {importResult.items.map((item) => (
                          <div
                            key={item.externalListingId}
                            className="flex items-center justify-between rounded-md border p-2 text-sm"
                          >
                            <div className="flex-1 truncate">
                              <div className="font-medium truncate">
                                {item.title}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                SKU: {item.sku || "Sem SKU"} | ID:{" "}
                                {item.externalListingId}
                              </div>
                            </div>
                            {item.linkedProductId ? (
                              <Badge
                                variant="default"
                                className="ml-2 shrink-0"
                              >
                                Vinculado
                              </Badge>
                            ) : (
                              <Badge
                                variant="secondary"
                                className="ml-2 shrink-0"
                              >
                                Sem vínculo
                              </Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

              {/* Erros */}
              {importResult.errors.length > 0 && (
                <div className="rounded-md bg-destructive/10 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    {importResult.errors.length} erro(s) durante importação
                  </div>
                  <ul className="mt-2 list-inside list-disc text-xs text-destructive">
                    {importResult.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Card de Sincronização */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Sincronizar Estoque
          </CardTitle>
          <CardDescription>
            Envia o estoque atual dos produtos vinculados para o Mercado Livre.
            Somente produtos com vínculo ativo serão sincronizados.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded border px-2 py-1 text-sm"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
            >
              <option value="">Todas as contas</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.accountName || acc.id}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={handleSync} disabled={isSyncing} variant="secondary">
            {isSyncing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sincronizando...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Sincronizar Estoque com ML
              </>
            )}
          </Button>

          {/* Resultado da sincronização */}
          {syncResult && (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                {syncResult.message ? (
                  <RefreshCw className="h-5 w-5 text-blue-500" />
                ) : syncResult.failed === 0 ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                )}
                <span className="font-medium">
                  {syncResult.message || "Sincronização concluída"}
                </span>
              </div>

              {!syncResult.message && (
                <>
                  <div className="grid grid-cols-1 gap-4 text-center sm:grid-cols-3">
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-2xl font-bold">
                        {syncResult.total}
                      </div>
                      <div className="text-xs text-muted-foreground">Total</div>
                    </div>
                    <div className="rounded-md bg-green-100 p-3 dark:bg-green-900/20">
                      <div className="text-2xl font-bold text-green-700 dark:text-green-400">
                        {syncResult.successful}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Sucesso
                      </div>
                    </div>
                    <div className="rounded-md bg-red-100 p-3 dark:bg-red-900/20">
                      <div className="text-2xl font-bold text-red-700 dark:text-red-400">
                        {syncResult.failed}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Falhas
                      </div>
                    </div>
                  </div>

                  {/* Lista de resultados */}
                  {syncResult.results.length > 0 && (
                    <Accordion type="single" collapsible className="w-full">
                      <AccordionItem value="results">
                        <AccordionTrigger className="text-sm">
                          Ver detalhes ({syncResult.results.length} produtos)
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="max-h-60 space-y-2 overflow-y-auto">
                            {syncResult.results.map((result) => (
                              <div
                                key={result.productId}
                                className="flex items-center justify-between rounded-md border p-2 text-sm"
                              >
                                <div className="flex-1">
                                  <div className="font-mono text-xs">
                                    {result.externalListingId}
                                  </div>
                                  {result.success ? (
                                    <div className="text-xs text-muted-foreground">
                                      Estoque: {result.previousStock} →{" "}
                                      {result.newStock}
                                    </div>
                                  ) : (
                                    <div className="text-xs text-destructive">
                                      {result.error}
                                    </div>
                                  )}
                                </div>
                                {result.success ? (
                                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                                ) : (
                                  <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                                )}
                              </div>
                            ))}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  )}

                  {syncResult.total === 0 && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Package className="h-4 w-4" />
                      <span>
                        Nenhum produto vinculado encontrado. Importe seus
                        anúncios primeiro.
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
