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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { FacebookConnectionSkeleton } from "./facebook-skeleton";

interface ConnectionStatus {
  connected: boolean;
  platform: string;
  status?: string;
  message: string;
}

export function FacebookConnectionTab() {
  const { data: session } = useSession();
  // Colaboradores (usuários com parentUserId) não podem conectar/desconectar.
  // Backend também valida via blockCollaborator middleware (HTTP 403).
  const isCollaborator = Boolean((session?.user as any)?.parentUserId);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{
      id: string;
      accountName: string;
      status?: string;
      fbCatalogId?: string | null;
      fbProductUrlBase?: string | null;
    }>
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rascunho editável das configs do catálogo por conta (catalogId/urlBase).
  const [catalogDrafts, setCatalogDrafts] = useState<
    Record<string, { catalogId: string; urlBase: string }>
  >({});
  const [savingCatalogId, setSavingCatalogId] = useState<string | null>(null);
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
        `${getApiBaseUrl()}/marketplace/facebook/status`,
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
          `${getApiBaseUrl()}/marketplace/facebook/accounts`,
          { headers: { email: session.user.email } },
        );
        if (accRes.ok) {
          const accData = await accRes.json();
          const accountsList = Array.isArray(accData.accounts)
            ? accData.accounts
            : [];
          setAccounts(accountsList);
          setCatalogDrafts(
            Object.fromEntries(
              accountsList.map((acc: { id: string; fbCatalogId?: string | null; fbProductUrlBase?: string | null }) => [
                acc.id,
                {
                  catalogId: acc.fbCatalogId ?? "",
                  urlBase: acc.fbProductUrlBase ?? "",
                },
              ]),
            ),
          );
        } else {
          setAccounts([]);
        }
      } else {
        setAccounts([]);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Erro desconhecido";
      console.error("[Facebook Marketplace] Erro em fetchStatus:", errorMsg);
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
        `${getApiBaseUrl()}/marketplace/facebook/auth`,
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
        "facebook-oauth",
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
      const url = new URL(`${getApiBaseUrl()}/marketplace/facebook`);
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

  // Salva as configs do catálogo (id/URL base) da conta. Depende do endpoint
  // PATCH /marketplace/facebook/accounts/:id (ver relatório) — ainda inexistente.
  const handleSaveCatalog = async (accountId: string) => {
    if (!session?.user?.email) return;
    const draft = catalogDrafts[accountId];
    if (!draft) return;

    setSavingCatalogId(accountId);
    setError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/marketplace/facebook/accounts/${accountId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
          body: JSON.stringify({
            fbCatalogId: draft.catalogId || null,
            fbProductUrlBase: draft.urlBase || null,
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || "Erro ao salvar dados do catálogo");
      }

      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                fbCatalogId: draft.catalogId || null,
                fbProductUrlBase: draft.urlBase || null,
              }
            : a,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSavingCatalogId(null);
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

      if (event.data?.type === "FACEBOOK_OAUTH_SUCCESS") {
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
      } else if (event.data?.type === "FACEBOOK_OAUTH_ERROR") {
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
    return <FacebookConnectionSkeleton />;
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
            ? "Sua conta do Facebook está conectada"
            : "Conecte sua conta do Facebook para sincronizar o catálogo"}
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
                  className="relative overflow-hidden rounded-lg border border-border/60 bg-card p-3"
                >
                  <span
                    className="absolute inset-y-0 left-0 w-1 bg-emerald-500"
                    aria-hidden
                  />
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1.5 pl-1.5">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <span className="truncate font-semibold [font-family:var(--font-bricolage)]">
                          {acc.accountName || "Conta Facebook"}
                        </span>
                      </div>
                      <span className="inline-flex items-center rounded-full bg-emerald-500/12 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                        {acc.status || status.status || "Ativo"}
                      </span>
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
                  {!isCollaborator && (
                    <div className="mt-3 space-y-3 border-t border-border/60 pl-1.5 pt-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor={`fb-catalog-${acc.id}`}>
                            ID do catálogo
                          </Label>
                          <Input
                            id={`fb-catalog-${acc.id}`}
                            value={catalogDrafts[acc.id]?.catalogId ?? ""}
                            onChange={(e) =>
                              setCatalogDrafts((prev) => ({
                                ...prev,
                                [acc.id]: {
                                  catalogId: e.target.value,
                                  urlBase: prev[acc.id]?.urlBase ?? "",
                                },
                              }))
                            }
                            placeholder="123456789012345"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`fb-urlbase-${acc.id}`}>
                            URL base do produto
                          </Label>
                          <Input
                            id={`fb-urlbase-${acc.id}`}
                            value={catalogDrafts[acc.id]?.urlBase ?? ""}
                            onChange={(e) =>
                              setCatalogDrafts((prev) => ({
                                ...prev,
                                [acc.id]: {
                                  catalogId: prev[acc.id]?.catalogId ?? "",
                                  urlBase: e.target.value,
                                },
                              }))
                            }
                            placeholder="https://loja.com/produto"
                          />
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleSaveCatalog(acc.id)}
                        disabled={savingCatalogId === acc.id}
                      >
                        {savingCatalogId === acc.id ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Salvando...
                          </>
                        ) : (
                          "Salvar dados do catálogo"
                        )}
                      </Button>
                    </div>
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
                        Desconectar todas as contas Facebook?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Esta ação removerá as conexões das contas do Facebook.
                        Você não perderá seus itens no catálogo, mas a
                        sincronização será interrompida.
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
                A gestão das conexões com marketplaces é feita pelo
                administrador da conta. Você pode usar as contas conectadas para
                criar anúncios.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {isCollaborator
                ? "Nenhuma conta do Facebook conectada. Solicite ao administrador da conta para conectar."
                : "Ao conectar, você poderá sincronizar automaticamente o estoque dos seus produtos com o catálogo do Facebook/Meta."}
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
                    Conectar ao Facebook
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
