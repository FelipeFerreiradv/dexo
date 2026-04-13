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
  success: boolean;
  totalItems: number;
  linkedItems: number;
  unlinkedItems: number;
  errorCount?: number;
  itemsPreviewTruncated?: boolean;
  errorsPreviewTruncated?: boolean;
  items: ImportItem[];
  errors: string[];
}

interface ImportProgress {
  state: "queued" | "running" | "completed" | "failed";
  phase:
    | "queued"
    | "listing"
    | "details"
    | "processing"
    | "completed"
    | "failed";
  totalItemIds: number;
  totalItems: number;
  pagesFetched: number;
  fetchedBaseInfo: number;
  processedItems: number;
  linkedItems: number;
  unlinkedItems: number;
  errorCount: number;
  itemsPreviewTruncated?: boolean;
  errorsPreviewTruncated?: boolean;
  startedAt: string;
  finishedAt?: string;
  message?: string;
}

interface ImportJobStartResponse {
  success: boolean;
  importId: string;
  status: "queued" | "running" | "completed" | "failed";
  message: string;
}

interface ImportJobStatusResponse {
  success: boolean;
  importId: string;
  status: "queued" | "running" | "completed" | "failed";
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

export function ShopeeSyncTab() {
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
    Array<{ id: string; accountName: string; shopId?: number }>
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");

  const pollImportStatus = useCallback(
    async (jobId: string) => {
      if (!session?.user?.email) return;

      const response = await fetch(
        `${getApiBaseUrl()}/marketplace/shopee/import/${jobId}`,
        {
          headers: {
            email: session.user.email,
          },
        },
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Erro ao consultar importação");
      }

      const statusData = data as ImportJobStatusResponse;
      setImportStatus(statusData.status);
      setImportProgress(statusData.progress);

      if (statusData.result) {
        setImportResult(statusData.result);
      }

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
            "Erro ao importar anúncios do Shopee",
        );
      }
    },
    [session?.user?.email],
  );

  // Importar itens do Shopee
  const handleImport = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsImporting(true);
    setError(null);
    setImportResult(null);
    setImportJobId(null);
    setImportStatus(null);
    setImportProgress(null);

    try {
      const url = new URL(`${getApiBaseUrl()}/marketplace/shopee/import`);
      if (selectedAccountId) url.searchParams.set("accountId", selectedAccountId);

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
      setImportProgress((prev) => ({
        state: data.status,
        phase: prev?.phase || "queued",
        totalItemIds: prev?.totalItemIds || 0,
        totalItems: prev?.totalItems || 0,
        pagesFetched: prev?.pagesFetched || 0,
        fetchedBaseInfo: prev?.fetchedBaseInfo || 0,
        processedItems: prev?.processedItems || 0,
        linkedItems: prev?.linkedItems || 0,
        unlinkedItems: prev?.unlinkedItems || 0,
        errorCount: prev?.errorCount || 0,
        startedAt: prev?.startedAt || new Date().toISOString(),
        finishedAt: prev?.finishedAt,
        message: data.message,
      }));
    } catch (err) {
      setImportJobId(null);
      setImportStatus(null);
      setError(err instanceof Error ? err.message : "Erro ao importar");
      setIsImporting(false);
    }
  }, [session?.user?.email, selectedAccountId]);

  // Sincronizar estoque para o Shopee
  const handleSync = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsSyncing(true);
    setError(null);
    setSyncResult(null);

    try {
      const url = new URL(`${getApiBaseUrl()}/marketplace/shopee/sync`);
      if (selectedAccountId) url.searchParams.set("accountId", selectedAccountId);

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
        setSyncResult(data as SyncResponse);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao sincronizar");
    } finally {
      setIsSyncing(false);
    }
  }, [session?.user?.email, selectedAccountId]);

  // Carregar contas para seleção
  useEffect(() => {
    const loadAccounts = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/marketplace/shopee/accounts`,
          { headers: { email: session.user.email } },
        );
        if (res.ok) {
          const data = await res.json();
          setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
        }
      } catch {
        /* ignore */
      }
    };
    loadAccounts();
  }, [session?.user?.email]);

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
            Busca seus anúncios no Shopee e tenta vincular automaticamente aos
            produtos do seu estoque através do SKU.
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
          <Button onClick={handleImport} disabled={isImporting}>
            {isImporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {importStatus === "queued" ? "Enfileirando..." : "Importando..."}
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Importar Anúncios do Shopee
              </>
            )}
          </Button>

          {/* Resultado da importação */}
          {isImporting && importProgress && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="font-medium">
                  ImportaÃ§Ã£o Shopee em andamento
                </span>
              </div>
              {importProgress.message && (
                <p className="text-sm text-muted-foreground">
                  {importProgress.message}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3 text-center md:grid-cols-4">
                <div className="rounded-md bg-background p-3">
                  <div className="text-lg font-semibold">
                    {importProgress.totalItemIds}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    IDs coletados
                  </div>
                </div>
                <div className="rounded-md bg-background p-3">
                  <div className="text-lg font-semibold">
                    {importProgress.fetchedBaseInfo}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Base info
                  </div>
                </div>
                <div className="rounded-md bg-background p-3">
                  <div className="text-lg font-semibold">
                    {importProgress.processedItems}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Processados
                  </div>
                </div>
                <div className="rounded-md bg-background p-3">
                  <div className="text-lg font-semibold">
                    {importProgress.errorCount}
                  </div>
                  <div className="text-xs text-muted-foreground">Erros</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                O processamento continua no backend e a interface consulta o
                progresso periodicamente.
              </p>
            </div>
          )}

          {importResult && (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                {importStatus === "failed" ? (
                  <XCircle className="h-5 w-5 text-red-500" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                )}
                <span className="font-medium">Importação concluída</span>
              </div>

              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="rounded-md bg-muted p-3">
                  <div className="text-2xl font-bold">
                    {importResult.totalItems}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Total de itens
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

              {/* Detalhes dos erros */}
              {(importResult.errorCount ?? importResult.errors.length) > 0 && (
                <Accordion type="single" collapsible>
                  <AccordionItem value="errors">
                    <AccordionTrigger className="text-sm">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-red-500" />
                        {importResult.errorCount ?? importResult.errors.length} erro(s) encontrado(s)
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-2">
                        {importResult.errors.map((error, index) => (
                          <div
                            key={index}
                            className="rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400"
                          >
                            {error}
                          </div>
                        ))}
                        {importResult.errorsPreviewTruncated && (
                          <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                            Exibindo apenas uma prÃ©via dos erros.
                          </div>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

              {/* Detalhes dos itens não vinculados */}
              {importResult.unlinkedItems > 0 && (
                <Accordion type="single" collapsible>
                  <AccordionItem value="unlinked">
                    <AccordionTrigger className="text-sm">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-yellow-500" />
                        {importResult.unlinkedItems} item(s) não vinculado(s)
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-2">
                        {importResult.items
                          .filter((item) => item.status === "unlinked")
                          .map((item) => (
                            <div
                              key={item.externalListingId}
                              className="flex items-center justify-between rounded-md border p-3"
                            >
                              <div>
                                <div className="font-medium">{item.title}</div>
                                <div className="text-sm text-muted-foreground">
                                  SKU: {item.sku || "Não informado"}
                                </div>
                              </div>
                              <Badge variant="outline">Não vinculado</Badge>
                            </div>
                          ))}
                        {importResult.itemsPreviewTruncated && (
                          <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                            Exibindo apenas uma prÃ©via dos itens processados.
                          </div>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card de Sincronização */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Sincronizar Estoque
          </CardTitle>
          <CardDescription>
            Atualiza o estoque de todos os produtos vinculados no Shopee com os
            valores do seu estoque central.
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
          <Button onClick={handleSync} disabled={isSyncing}>
            {isSyncing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sincronizando...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Sincronizar Estoque
              </>
            )}
          </Button>

          {/* Resultado da sincronização */}
          {syncResult && (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                {syncResult.failed === 0 ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                )}
                <span className="font-medium">
                  {syncResult.message || "Sincronização concluída"}
                </span>
              </div>

              {!syncResult.message && (
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="rounded-md bg-muted p-3">
                  <div className="text-2xl font-bold">{syncResult.total}</div>
                  <div className="text-xs text-muted-foreground">Total</div>
                </div>
                <div className="rounded-md bg-green-100 p-3 dark:bg-green-900/20">
                  <div className="text-2xl font-bold text-green-700 dark:text-green-400">
                    {syncResult.successful}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Bem-sucedidos
                  </div>
                </div>
                <div className="rounded-md bg-red-100 p-3 dark:bg-red-900/20">
                  <div className="text-2xl font-bold text-red-700 dark:text-red-400">
                    {syncResult.failed}
                  </div>
                  <div className="text-xs text-muted-foreground">Falharam</div>
                </div>
              </div>
              )}

              {/* Detalhes dos resultados */}
              {!syncResult.message && syncResult.results.length > 0 && (
                <Accordion type="single" collapsible>
                  <AccordionItem value="results">
                    <AccordionTrigger className="text-sm">
                      Ver detalhes dos resultados
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-2">
                        {syncResult.results.map((result) => (
                          <div
                            key={result.externalListingId}
                            className="flex items-center justify-between rounded-md border p-3"
                          >
                            <div>
                              <div className="font-medium">
                                Produto {result.productId}
                              </div>
                              <div className="text-sm text-muted-foreground">
                                ID: {result.externalListingId}
                              </div>
                              {result.previousStock !== undefined &&
                                result.newStock !== undefined && (
                                  <div className="text-sm text-muted-foreground">
                                    Estoque: {result.previousStock} →{" "}
                                    {result.newStock}
                                  </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                              {result.success ? (
                                <Badge variant="default">Sucesso</Badge>
                              ) : (
                                <Badge variant="destructive">Erro</Badge>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
