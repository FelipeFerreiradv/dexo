"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Unplug,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";
import { shopeeAccountLabel } from "@/app/marketplaces/lib/shopee-account-label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface ConnectionStatus {
  connected: boolean;
  platform: string;
  status?: string;
  message: string;
}

export function ShopeeConnectionTab() {
  const { data: session } = useSession();
  // Colaboradores não podem conectar/desconectar — backend bloqueia via 403.
  const isCollaborator = Boolean((session?.user as any)?.parentUserId);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{
      id: string;
      accountName: string;
      status?: string;
      shopId?: number;
      shopName?: string;
      region?: string;
      merchantName?: string;
      externalUserId?: string | null;
    }>
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Verifica status de conexão (com proteção contra múltiplas chamadas simultâneas)
  const fetchStatus = useCallback(async () => {
    if (!session?.user?.email) return;

    if (fetchStatus.isRunning) {
      console.log(
        "[Shopee Marketplace] fetchStatus já em execução, ignorando chamada duplicada",
      );
      return;
    }

    fetchStatus.isRunning = true;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/marketplace/shopee/status`,
        {
          headers: {
            email: session.user.email,
          },
        },
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao verificar status");
      }

      const data: ConnectionStatus = await response.json();
      setStatus(data);

      const accRes = await fetch(
        `${getApiBaseUrl()}/marketplace/shopee/accounts`,
        { headers: { email: session.user.email } },
      );
      if (accRes.ok) {
        const accData = await accRes.json();
        setAccounts(Array.isArray(accData.accounts) ? accData.accounts : []);
      } else {
        setAccounts([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      fetchStatus.isRunning = false;
      setIsLoading(false);
    }
  }, [session?.user?.email]);

  // Inicia fluxo OAuth via popup
  const handleConnect = async () => {
    const userEmail = session?.user?.email;

    if (!userEmail) {
      setError("Sessão não encontrada. Faça login novamente.");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      // 1. Obter URL de autenticação do backend
      const response = await fetch(
        `${getApiBaseUrl()}/marketplace/shopee/auth`,
        {
          method: "POST",
          headers: {
            email: userEmail,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao iniciar autenticação");
      }

      const { authUrl, state } = await response.json();

      // 2. Abrir popup para autenticação
      const popup = window.open(
        authUrl,
        "shopee-auth",
        "width=600,height=700,scrollbars=yes,resizable=yes",
      );

      if (!popup) {
        throw new Error("Popup bloqueado. Permita popups para este site.");
      }

      // 3. Monitorar popup e aguardar callback
      // O postMessage do callback page é o mecanismo principal (vide useEffect abaixo)
      // Este polling é o fallback seguro
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          clearTimeout(hardTimeout);
          setIsConnecting(false);
          console.log("[Shopee OAuth] Popup fechado, atualizando status...");
          // Delay para garantir que o backend persistiu a conta
          setTimeout(() => {
            fetchStatus.isRunning = false;
            fetchStatus();
          }, 1000);
        }
      }, 500);

      // Hard timeout de 5 minutos (segurança)
      const hardTimeout = setTimeout(
        () => {
          clearInterval(checkClosed);
          if (!popup.closed) {
            popup.close();
          }
          setIsConnecting(false);
          setError("Timeout na autenticação. Tente novamente.");
        },
        5 * 60 * 1000,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro na autenticação");
      setIsConnecting(false);
    }
  };

  // Desconectar conta
  const handleDisconnect = useCallback(
    async (accountId?: string) => {
      if (!session?.user?.email) return;

      setIsDisconnecting(true);
      setError(null);

      try {
        const url = new URL(`${getApiBaseUrl()}/marketplace/shopee`);
        if (accountId) url.searchParams.set("accountId", accountId);

        const response = await fetch(url.toString(), {
          method: "DELETE",
          headers: {
            email: session.user.email,
          },
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.message || "Erro ao desconectar");
        }

        // Recarregar status
        await fetchStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro ao desconectar");
      } finally {
        setIsDisconnecting(false);
      }
    },
    [session?.user?.email, fetchStatus],
  );

  // Carregar status inicial
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Listener para mensagens do popup (callback success) - MECANISMO PRINCIPAL
  useEffect(() => {
    let isMountedRef = true;

    const handleMessage = (event: MessageEvent) => {
      if (typeof window !== "undefined") {
        const isValidOrigin =
          event.origin === window.location.origin ||
          event.origin.includes("localhost");

        if (!isValidOrigin) {
          return;
        }
      }

      if (event.data?.type === "SHOPEE_OAUTH_SUCCESS") {
        if (!isMountedRef) return;

        console.log("[Shopee OAuth] Sucesso confirmado via postMessage");
        setIsConnecting(false);

        // Retry fetchStatus com delays crescentes caso o status ainda não reflita a conexão
        const retryFetch = async (attempt: number) => {
          if (!isMountedRef) return;
          fetchStatus.isRunning = false;
          await fetchStatus();
          setTimeout(() => {
            if (!isMountedRef) return;
            setStatus((currentStatus) => {
              if (!currentStatus?.connected && attempt < 3) {
                console.log(
                  `[Shopee OAuth] Retentativa ${attempt + 1} de fetchStatus...`,
                );
                retryFetch(attempt + 1);
              }
              return currentStatus;
            });
          }, 1500);
        };

        // Espera inicial para o backend persistir a conta
        setTimeout(() => retryFetch(0), 800);
      } else if (event.data?.type === "SHOPEE_OAUTH_ERROR") {
        if (!isMountedRef) return;

        console.error(
          "[Shopee OAuth] Erro confirmado via postMessage:",
          event.data.message,
        );
        setIsConnecting(false);
        setError(event.data.message || "Erro na autenticação");
      }
    };

    window.addEventListener("message", handleMessage);

    return () => {
      isMountedRef = false;
      window.removeEventListener("message", handleMessage);
    };
  }, [fetchStatus]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="ml-2">Verificando conexão...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {status?.connected ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <XCircle className="h-5 w-5 text-red-500" />
            )}
            Status da Conexão
          </CardTitle>
          <CardDescription>
            {status?.connected
              ? "Sua conta do Shopee está conectada e funcionando."
              : "Conecte sua conta do Shopee para começar a vender."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.connected ? (
            <div className="space-y-4">
              <div className="space-y-2">
                {accounts.map((acc) => (
                  <div
                    key={acc.id}
                    className="relative flex items-center justify-between gap-3 overflow-hidden rounded-lg border border-border/60 bg-card p-3"
                  >
                    <span
                      className="absolute inset-y-0 left-0 w-1 bg-emerald-500"
                      aria-hidden
                    />
                    <div className="min-w-0 space-y-1.5 pl-1.5">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <span className="truncate font-semibold [font-family:var(--font-bricolage)]">
                          {/* Mesmo rotulo das demais telas: a marca sempre na
                              frente. Antes esta aba mostrava o `shopName` cru e
                              o resto do sistema o `accountName` — dois nomes
                              para a mesma conta. */}
                          {acc.shopName
                            ? shopeeAccountLabel(acc.shopName, acc.shopId ?? "")
                            : acc.accountName || "Conta Shopee"}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {(() => {
                          const username =
                            acc.merchantName ||
                            acc.externalUserId ||
                            (acc.shopId ? `Shop ${acc.shopId}` : null);
                          const parts: string[] = [];
                          if (username) parts.push(`@${username}`);
                          if (acc.shopId && username !== `Shop ${acc.shopId}`) {
                            parts.push(`Shop ${acc.shopId}`);
                          }
                          return parts.length ? (
                            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                              {parts.join(" • ")}
                            </span>
                          ) : null;
                        })()}
                        <span className="inline-flex items-center rounded-full bg-emerald-500/12 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                          {acc.status || status.status || "Ativo"}
                        </span>
                      </div>
                    </div>
                    {!isCollaborator && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDisconnect(acc.id)}
                        disabled={isDisconnecting}
                      >
                        <Unplug className="mr-2 h-4 w-4" />
                        Desconectar
                      </Button>
                    )}
                  </div>
                ))}
                {accounts.length === 0 && (
                  <div className="rounded-lg bg-green-50 p-4 dark:bg-green-900/20">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                      <div>
                        <p className="font-medium text-green-800 dark:text-green-200">
                          Conectado ao Shopee
                        </p>
                        <p className="text-sm text-green-600 dark:text-green-300">
                          {status.message}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {!isCollaborator && (
                <div className="flex gap-2">
                  <Button
                    onClick={handleConnect}
                    disabled={isConnecting || isDisconnecting}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Conectando...
                      </>
                    ) : (
                      <>
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Adicionar nova conta
                      </>
                    )}
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" disabled={isDisconnecting}>
                        {isDisconnecting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Desconectando...
                          </>
                        ) : (
                          <>
                            <Unplug className="mr-2 h-4 w-4" />
                            Desconectar todas
                          </>
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Desconectar Shopee</AlertDialogTitle>
                        <AlertDialogDescription>
                          Tem certeza que deseja desconectar todas as contas do
                          Shopee? Isso removerá as vinculações e você precisará
                          reconectar para continuar sincronizando.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction onClick={() => handleDisconnect()}>
                          Desconectar tudo
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
              {isCollaborator && (
                <p className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                  A gestão das conexões com marketplaces é feita pelo
                  administrador da conta. Você pode usar as contas conectadas
                  para criar anúncios.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg bg-yellow-50 p-4 dark:bg-yellow-900/20">
                <div className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                  <div>
                    <p className="font-medium text-yellow-800 dark:text-yellow-200">
                      Não conectado
                    </p>
                    <p className="text-sm text-yellow-600 dark:text-yellow-300">
                      {isCollaborator
                        ? "Solicite ao administrador da conta para conectar uma conta Shopee."
                        : status?.message || "Conecte sua conta para começar."}
                    </p>
                  </div>
                </div>
              </div>

              {!isCollaborator && (
                <Button onClick={handleConnect} disabled={isConnecting}>
                  {isConnecting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Conectando...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Conectar Shopee
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
