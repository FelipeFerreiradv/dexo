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

export function ShopeeSyncTab() {
  const { data: session } = useSession();
  const [isImporting, setIsImporting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{ id: string; accountName: string; shopId?: number }>
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");

  // Importar itens do Shopee
  const handleImport = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsImporting(true);
    setError(null);
    setImportResult(null);

    try {
      const url = new URL("http://localhost:3333/marketplace/shopee/import");
      if (selectedAccountId) url.searchParams.set("accountId", selectedAccountId);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          email: session.user.email,
        },
      });

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
  }, [session?.user?.email, selectedAccountId]);

  // Sincronizar estoque para o Shopee
  const handleSync = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsSyncing(true);
    setError(null);
    setSyncResult(null);

    try {
      const url = new URL("http://localhost:3333/marketplace/shopee/sync");
      if (selectedAccountId) url.searchParams.set("accountId", selectedAccountId);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          email: session.user.email,
        },
      });

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
  }, [session?.user?.email, selectedAccountId]);

  // Carregar contas para seleção
  useEffect(() => {
    const loadAccounts = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(
          "http://localhost:3333/marketplace/shopee/accounts",
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
                Importando...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Importar Anúncios do Shopee
              </>
            )}
          </Button>

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

              {/* Detalhes dos erros */}
              {importResult.errors.length > 0 && (
                <Accordion type="single" collapsible>
                  <AccordionItem value="errors">
                    <AccordionTrigger className="text-sm">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-red-500" />
                        {importResult.errors.length} erro(s) encontrado(s)
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

              {/* Detalhes dos resultados */}
              {syncResult.results.length > 0 && (
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
