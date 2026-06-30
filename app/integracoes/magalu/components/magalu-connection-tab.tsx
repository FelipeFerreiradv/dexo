"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import { MagaluConnectionSkeleton } from "./magalu-skeleton";

interface ConnectionStatus {
  connected: boolean;
  platform: string;
  status?: string;
  message: string;
}

export function MagaluConnectionTab() {
  const { data: session } = useSession();
  // Colaboradores (usuários com parentUserId) não podem conectar/desconectar.
  // Backend também valida via blockCollaborator middleware (HTTP 403).
  const isCollaborator = Boolean((session?.user as any)?.parentUserId);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{ id: string; accountName: string; status?: string }>
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guard contra chamadas simultâneas de fetchStatus (type-safe via ref,
  // em vez de anexar propriedade à função como em ML/Shopee).
  const isFetchingRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (!session?.user?.email) return;

    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/marketplace/magalu/status`,
        { headers: { email: session.user.email } },
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao verificar status");
      }

      const data: ConnectionStatus = await response.json();
      setStatus(data);

      if (data.connected) {
        const accRes = await fetch(
          `${getApiBaseUrl()}/marketplace/magalu/accounts`,
          { headers: { email: session.user.email } },
        );
        if (accRes.ok) {
          const accData = await accRes.json();
          const accountsList = Array.isArray(accData.accounts)
            ? accData.accounts
            : [];
          setAccounts(accountsList);
        } else {
          setAccounts([]);
        }
      } else {
        setAccounts([]);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Erro desconhecido";
      console.error("[Magalu Marketplace] Erro em fetchStatus:", errorMsg);
      setError(errorMsg);
    } finally {
      isFetchingRef.current = false;
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
      const response = await fetch(
        `${getApiBaseUrl()}/marketplace/magalu/auth`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", email: userEmail },
          body: JSON.stringify({}),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao iniciar autenticação");
      }

      const { authUrl } = await response.json();

      const popup = window.open(
        authUrl,
        "magalu-oauth",
        "width=600,height=700,scrollbars=yes,resizable=yes",
      );

      if (!popup) {
        throw new Error(
          "Não foi possível abrir o popup. Verifique se popups estão bloqueados.",
        );
      }

      // Polling de fallback: detecta fechamento do popup
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          clearTimeout(hardTimeout);
          setIsConnecting(false);
          setTimeout(() => {
            isFetchingRef.current = false;
            fetchStatus();
          }, 1000);
        }
      }, 500);

      const hardTimeout = setTimeout(
        () => {
          clearInterval(checkClosed);
          if (!popup.closed) {
            popup.close();
          }
          setIsConnecting(false);
          setError("Tempo limite excedido. Tente novamente.");
        },
        5 * 60 * 1000,
      );
    } catch (err) {
      setIsConnecting(false);
      setError(err instanceof Error ? err.message : "Erro ao conectar");
    }
  };

  // Desconecta conta
  const handleDisconnect = async (accountId?: string) => {
    if (!session?.user?.email) return;

    setIsDisconnecting(true);
    setError(null);

    try {
      const url = new URL(`${getApiBaseUrl()}/marketplace/magalu`);
      if (accountId) url.searchParams.set("accountId", accountId);

      const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: { email: session.user.email },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao desconectar");
      }

      fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao desconectar");
    } finally {
      setIsDisconnecting(false);
    }
  };

  useEffect(() => {
    if (session?.user?.email) {
      fetchStatus();
    }
  }, [session?.user?.email, fetchStatus]);

  // Listener das mensagens do popup (callback) — mecanismo principal
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

      if (event.data?.type === "MAGALU_OAUTH_SUCCESS") {
        if (!isMountedRef) return;
        setIsConnecting(false);

        const retryFetch = async (attempt: number) => {
          if (!isMountedRef) return;
          isFetchingRef.current = false;
          await fetchStatus();
          setTimeout(() => {
            if (!isMountedRef) return;
            setStatus((currentStatus) => {
              if (!currentStatus?.connected && attempt < 3) {
                retryFetch(attempt + 1);
              }
              return currentStatus;
            });
          }, 1500);
        };

        setTimeout(() => retryFetch(0), 800);
      } else if (event.data?.type === "MAGALU_OAUTH_ERROR") {
        if (!isMountedRef) return;
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
    return <MagaluConnectionSkeleton />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {status?.connected ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <XCircle className="h-5 w-5 text-muted-foreground" />
          )}
          Status da Conexão
        </CardTitle>
        <CardDescription>
          {status?.connected
            ? "Sua conta da Magalu está conectada"
            : "Conecte sua conta da Magalu para sincronizar anúncios"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {status?.connected ? (
          <div className="space-y-4">
            <div className="space-y-2">
              {accounts.map((acc) => (
                <div
                  key={acc.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                      <span className="font-medium">
                        {acc.accountName || "Conta Magalu"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Status: {acc.status || status.status || "Ativo"}
                    </p>
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
                <p className="text-sm text-muted-foreground">
                  Nenhuma conta listada. Recarregue ou conecte uma nova conta.
                </p>
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
                      <AlertDialogTitle>
                        Desconectar todas as contas Magalu?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Esta ação removerá as conexões das contas da Magalu. Você
                        não perderá seus anúncios, mas a sincronização será
                        interrompida.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => handleDisconnect()}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Desconectar tudo
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
            {isCollaborator && (
              <p className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                A gestão das conexões com marketplaces é feita pelo administrador
                da conta. Você pode usar as contas conectadas para criar
                anúncios.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {isCollaborator
                ? "Nenhuma conta da Magalu conectada. Solicite ao administrador da conta para conectar."
                : "Ao conectar, você poderá sincronizar automaticamente o estoque dos seus produtos com os anúncios da Magalu."}
            </p>
            {!isCollaborator && (
              <Button
                onClick={handleConnect}
                disabled={isConnecting || !session?.user?.email}
              >
                {isConnecting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Conectando...
                  </>
                ) : (
                  <>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Conectar à Magalu
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
