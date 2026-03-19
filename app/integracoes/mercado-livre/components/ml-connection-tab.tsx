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
import { MLConnectionSkeleton } from "./ml-skeleton";

interface ConnectionStatus {
  connected: boolean;
  platform: string;
  status?: string;
  message: string;
}

export function MLConnectionTab() {
  const { data: session } = useSession();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{ id: string; accountName: string; status?: string }>
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Verifica status de conexão (com proteção contra múltiplas chamadas simultâneas)
  const fetchStatus = useCallback(async () => {
    if (!session?.user?.email) return;

    // Proteção contra múltiplas chamadas simultâneas (debouncing)
    if (fetchStatus.isRunning) {
      console.log(
        "[ML Marketplace] fetchStatus já em execução, ignorando chamada duplicada",
      );
      return;
    }

    fetchStatus.isRunning = true;
    setIsLoading(true);
    setError(null);

    try {
      // Fetch status
      const response = await fetch(`${getApiBaseUrl()}/marketplace/ml/status`, {
        headers: {
          email: session.user.email,
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao verificar status");
      }

      const data: ConnectionStatus = await response.json();
      setStatus(data);

      // Fetch lista de contas apenas se conectado
      if (data.connected) {
        const accRes = await fetch(
          `${getApiBaseUrl()}/marketplace/ml/accounts`,
          { headers: { email: session.user.email } },
        );
        if (accRes.ok) {
          const accData = await accRes.json();
          // Garantir que accounts é um array mesmo se vazio
          const accountsList = Array.isArray(accData.accounts)
            ? accData.accounts
            : [];

          if (accountsList.length === 0) {
            console.warn(
              "[ML Marketplace] Nenhuma conta retornada pelo backend",
            );
          }

          setAccounts(accountsList);
        } else {
          console.error(
            "[ML Marketplace] Erro ao buscar contas:",
            accRes.status,
          );
          setAccounts([]);
        }
      } else {
        setAccounts([]);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Erro desconhecido";
      console.error("[ML Marketplace] Erro em fetchStatus:", errorMsg);
      setError(errorMsg);
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
      const response = await fetch(`${getApiBaseUrl()}/marketplace/ml/auth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          email: userEmail,
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao iniciar autenticação");
      }

      const { authUrl, state } = await response.json();

      // 2. Abrir popup com a URL de autorização
      const popup = window.open(
        authUrl,
        "ml-oauth",
        "width=600,height=700,scrollbars=yes,resizable=yes",
      );

      if (!popup) {
        throw new Error(
          "Não foi possível abrir o popup. Verifique se popups estão bloqueados.",
        );
      }

      // 3. Polling para detectar quando o popup fecha
      // O postMessage do callback page é o mecanismo principal (vide useEffect abaixo)
      // Este polling é o fallback seguro
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          clearTimeout(hardTimeout);
          setIsConnecting(false);
          console.log("[ML OAuth] Popup fechado, atualizando status...");
          // Delay para garantir que o backend persistiu a conta
          setTimeout(() => {
            fetchStatus();
          }, 1000);
        }
      }, 500);

      // 4. Hard timeout de 5 minutos (segurança)
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
      const url = new URL(`${getApiBaseUrl()}/marketplace/ml`);
      if (accountId) url.searchParams.set("accountId", accountId);

      const response = await fetch(url.toString(), {
        method: "DELETE",
        headers: { email: session.user.email },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao desconectar");
      }

      // Atualizar listagem/status
      fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao desconectar");
    } finally {
      setIsDisconnecting(false);
    }
  };

  // Buscar status ao montar componente
  useEffect(() => {
    if (session?.user?.email) {
      fetchStatus();
    }
  }, [session?.user?.email, fetchStatus]);

  // Listener para mensagens do popup (callback success) - MECANISMO PRINCIPAL
  useEffect(() => {
    let isMountedRef = true;

    const handleMessage = (event: MessageEvent) => {
      // Validar origin do postMessage (segurança)
      if (typeof window !== "undefined") {
        // Aceitar:
        // 1. Mesmo origin (normal em dev/prod - popup redirecionado para frontend)
        // 2. Localhost (para local testing)
        const isValidOrigin =
          event.origin === window.location.origin ||
          event.origin.includes("localhost");

        if (!isValidOrigin) {
          return;
        }
      }

      // Processar mensagens conhecidas
      if (event.data?.type === "ML_OAUTH_SUCCESS") {
        if (!isMountedRef) return;

        console.log("[ML OAuth] Sucesso confirmado via postMessage");
        setIsConnecting(false);

        // Pequeno delay para garantir consistência do banco
        setTimeout(() => {
          if (isMountedRef) {
            fetchStatus();
          }
        }, 500);
      } else if (event.data?.type === "ML_OAUTH_ERROR") {
        if (!isMountedRef) return;

        console.error(
          "[ML OAuth] Erro confirmado via postMessage:",
          event.data.message,
        );
        setIsConnecting(false);
        setError(event.data.message || "Erro na autenticação");
      }
    };

    // Registrar listener
    window.addEventListener("message", handleMessage);

    // Cleanup
    return () => {
      isMountedRef = false;
      window.removeEventListener("message", handleMessage);
    };
  }, [fetchStatus]);

  if (isLoading) {
    return <MLConnectionSkeleton />;
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
            ? "Sua conta do Mercado Livre está conectada"
            : "Conecte sua conta do Mercado Livre para sincronizar anúncios"}
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
            {/* Contas conectadas */}
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
                        {acc.accountName || "Conta Mercado Livre"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Status: {acc.status || status.status || "Ativo"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDisconnect(acc.id)}
                    disabled={isDisconnecting}
                  >
                    <Unplug className="mr-2 h-4 w-4" />
                    Desconectar
                  </Button>
                </div>
              ))}
              {accounts.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nenhuma conta listada. Recarregue ou conecte uma nova conta.
                </p>
              )}
            </div>

            {/* Ações globais */}
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
                      Desconectar todas as contas ML?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      Esta ação removerá as conexões das contas do Mercado
                      Livre. Você não perderá seus anúncios, mas a sincronização
                      será interrompida.
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
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Ao conectar, você poderá sincronizar automaticamente o estoque dos
              seus produtos com os anúncios do Mercado Livre.
            </p>
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
                  Conectar ao Mercado Livre
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
