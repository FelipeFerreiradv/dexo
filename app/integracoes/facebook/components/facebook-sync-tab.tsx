"use client";

import { useState, useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import {
  Upload,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Package,
  Info,
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

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

export function FacebookSyncTab() {
  const { data: session } = useSession();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{ id: string; accountName: string }>
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");

  const handleSync = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsSyncing(true);
    setError(null);
    setSyncResult(null);

    try {
      const url = new URL(`${getApiBaseUrl()}/marketplace/facebook/sync`);
      if (selectedAccountId)
        url.searchParams.set("accountId", selectedAccountId);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: { email: session.user.email },
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
        setSyncResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao sincronizar");
    } finally {
      setIsSyncing(false);
    }
  }, [session?.user?.email, selectedAccountId]);

  useEffect(() => {
    const loadAccounts = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/marketplace/facebook/accounts`,
          { headers: { email: session.user.email } },
        );
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

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Nota: Facebook é unidirecional (ERP→Meta) e sem importação de pedidos. */}
      <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          O Facebook/Meta não fornece webhook de venda nem importação de pedidos
          (checkout fora da plataforma). A baixa de estoque é{" "}
          <strong>unidirecional</strong> (Dexo → Meta): quando o estoque zera, o
          item é marcado como <strong>indisponível</strong> no catálogo; ao
          repor, volta a <strong>disponível</strong> (o item permanece no
          catálogo). Vendas feitas fora do Dexo devem ser registradas
          manualmente.
        </span>
      </div>

      {/* Card de Sincronização */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Sincronizar Estoque
          </CardTitle>
          <CardDescription>
            Envia o estoque atual dos produtos vinculados para o catálogo do
            Facebook. Somente produtos com vínculo ativo serão sincronizados.
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
                Sincronizar Estoque com o Facebook
              </>
            )}
          </Button>

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
                                      Estoque sincronizado: {result.newStock}
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
                        Nenhum produto vinculado encontrado. Publique itens no
                        catálogo do Facebook a partir dos seus produtos
                        primeiro.
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
