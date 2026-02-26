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
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Verifica status de conexão
  const fetchStatus = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        "http://localhost:3333/marketplace/shopee/status",
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
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
        "http://localhost:3333/marketplace/shopee/auth",
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
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          // Recarregar status após fechar popup
          fetchStatus();
          setIsConnecting(false);
        }
      }, 1000);

      // Timeout de 5 minutos
      setTimeout(
        () => {
          if (!popup.closed) {
            popup.close();
            clearInterval(checkClosed);
            setError("Timeout na autenticação. Tente novamente.");
            setIsConnecting(false);
          }
        },
        5 * 60 * 1000,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro na autenticação");
      setIsConnecting(false);
    }
  };

  // Desconectar conta
  const handleDisconnect = useCallback(async () => {
    if (!session?.user?.email) return;

    setIsDisconnecting(true);
    setError(null);

    try {
      const response = await fetch("http://localhost:3333/marketplace/shopee", {
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
  }, [session?.user?.email, fetchStatus]);

  // Carregar status inicial
  useEffect(() => {
    fetchStatus();
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
                        Desconectar Conta
                      </>
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Desconectar Shopee</AlertDialogTitle>
                    <AlertDialogDescription>
                      Tem certeza que deseja desconectar sua conta do Shopee?
                      Isso removerá todas as vinculações de produtos e você
                      precisará reconectar para continuar sincronizando.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDisconnect}>
                      Desconectar
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
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
                      {status?.message || "Conecte sua conta para começar."}
                    </p>
                  </div>
                </div>
              </div>

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
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
