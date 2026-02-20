"use client";

import { useState, useCallback } from "react";
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
  items: ImportItem[];
  errors: string[];
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
}

export function MLSyncTab() {
  const { data: session } = useSession();
  const [isImporting, setIsImporting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Importar itens do ML
  const handleImport = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsImporting(true);
    setError(null);
    setImportResult(null);

    try {
      const response = await fetch(
        "http://localhost:3333/marketplace/ml/import",
        {
          method: "POST",
          headers: {
            email: session.user.email,
          },
        },
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao importar itens");
      }

      const data: ImportResult = await response.json();
      setImportResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao importar");
    } finally {
      setIsImporting(false);
    }
  }, [session?.user?.email]);

  // Sincronizar estoque para o ML
  const handleSync = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsSyncing(true);
    setError(null);
    setSyncResult(null);

    try {
      const response = await fetch(
        "http://localhost:3333/marketplace/ml/sync",
        {
          method: "POST",
          headers: {
            email: session.user.email,
          },
        },
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao sincronizar estoque");
      }

      const data: SyncResponse = await response.json();
      setSyncResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao sincronizar");
    } finally {
      setIsSyncing(false);
    }
  }, [session?.user?.email]);

  // Forçar retry imediato de placeholders pendentes
  const handleRetryPending = useCallback(async () => {
    if (!session?.user?.email) return;
    setError(null);

    try {
      const res = await fetch(
        "http://localhost:3333/marketplace/ml/retry-pending",
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
          <div className="flex gap-2">
            <Button onClick={handleSync} disabled={isSyncing}>
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

            <Button variant="outline" onClick={handleRetryPending}>
              <Upload className="mr-2 h-4 w-4" />
              Re-tentar anúncios pendentes
            </Button>
          </div>

          {/* Resultado da importação */}
          {importResult && (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
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

              {/* Lista de itens importados */}
              {importResult.items.length > 0 && (
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
                {syncResult.failed === 0 ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                )}
                <span className="font-medium">Sincronização concluída</span>
              </div>

              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="rounded-md bg-muted p-3">
                  <div className="text-2xl font-bold">{syncResult.total}</div>
                  <div className="text-xs text-muted-foreground">Total</div>
                </div>
                <div className="rounded-md bg-green-100 p-3 dark:bg-green-900/20">
                  <div className="text-2xl font-bold text-green-700 dark:text-green-400">
                    {syncResult.successful}
                  </div>
                  <div className="text-xs text-muted-foreground">Sucesso</div>
                </div>
                <div className="rounded-md bg-red-100 p-3 dark:bg-red-900/20">
                  <div className="text-2xl font-bold text-red-700 dark:text-red-400">
                    {syncResult.failed}
                  </div>
                  <div className="text-xs text-muted-foreground">Falhas</div>
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
                    Nenhum produto vinculado encontrado. Importe seus anúncios
                    primeiro.
                  </span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
