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
import { OlxConnectionSkeleton } from "./olx-skeleton";

interface ConnectionStatus {
  connected: boolean;
  platform: string;
  status?: string;
  message: string;
}

export function OlxConnectionTab() {
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
      olxSellerPhone?: string | null;
      olxSellerZipcode?: string | null;
    }>
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rascunho editável dos dados do vendedor por conta (phone/zipcode).
  const [sellerDrafts, setSellerDrafts] = useState<
    Record<string, { phone: string; zipcode: string }>
  >({});
  const [savingSellerId, setSavingSellerId] = useState<string | null>(null);
  // E-mail da conta da OLX que vai ser autorizada. A OLX não expõe mais quem é
  // o dono do token (o endpoint basic_user_info dela responde 404), então é
  // este e-mail que identifica a conta e impede vincular a mesma conta duas
  // vezes. Só existe na OLX — os outros canais devolvem a identidade sozinhos.
  const [emailConta, setEmailConta] = useState("");
  const emailContaValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    emailConta.trim().toLowerCase(),
  );
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
        `${getApiBaseUrl()}/marketplace/olx/status`,
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
          `${getApiBaseUrl()}/marketplace/olx/accounts`,
          { headers: { email: session.user.email } },
        );
        if (accRes.ok) {
          const accData = await accRes.json();
          const accountsList = Array.isArray(accData.accounts)
            ? accData.accounts
            : [];
          setAccounts(accountsList);
          setSellerDrafts(
            Object.fromEntries(
              accountsList.map(
                (acc: {
                  id: string;
                  olxSellerPhone?: string | null;
                  olxSellerZipcode?: string | null;
                }) => [
                  acc.id,
                  {
                    phone: acc.olxSellerPhone ?? "",
                    zipcode: acc.olxSellerZipcode ?? "",
                  },
                ],
              ),
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
      console.error("[OLX Marketplace] Erro em fetchStatus:", errorMsg);
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

    if (!emailContaValido) {
      setError("Informe o e-mail da conta da OLX que você vai autorizar.");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const response = await fetch(`${getApiBaseUrl()}/marketplace/olx/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email: userEmail },
        body: JSON.stringify({ accountEmail: emailConta.trim() }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao iniciar autenticação");
      }

      const { authUrl } = await response.json();

      const popup = window.open(
        authUrl,
        "olx-oauth",
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
      const url = new URL(`${getApiBaseUrl()}/marketplace/olx`);
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

  // Salva os dados do vendedor (telefone/CEP) da conta. Depende do endpoint
  // PATCH /marketplace/olx/accounts/:id (ver relatório) — ainda inexistente.
  const handleSaveSeller = async (accountId: string) => {
    if (!session?.user?.email) return;
    const draft = sellerDrafts[accountId];
    if (!draft) return;

    setSavingSellerId(accountId);
    setError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/marketplace/olx/accounts/${accountId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
          body: JSON.stringify({
            olxSellerPhone: draft.phone || null,
            olxSellerZipcode: draft.zipcode || null,
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || "Erro ao salvar dados do vendedor");
      }

      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                olxSellerPhone: draft.phone || null,
                olxSellerZipcode: draft.zipcode || null,
              }
            : a,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSavingSellerId(null);
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

      if (event.data?.type === "OLX_OAUTH_SUCCESS") {
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
      } else if (event.data?.type === "OLX_OAUTH_ERROR") {
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
    return <OlxConnectionSkeleton />;
  }

  // `jaTemConta` só muda o texto: com uma conta na tela, o campo é para a
  // PRÓXIMA conta — sem isso o rótulo parece pedir de novo a que já está ali, e
  // o botão desabilitado ao lado passa a impressão de tela travada.
  const renderCampoEmailConta = (jaTemConta: boolean) => (
    <div className="space-y-1.5">
      <Label htmlFor="olx-account-email">
        {jaTemConta
          ? "E-mail da conta OLX que você quer adicionar"
          : "E-mail da conta da OLX"}
      </Label>
      <Input
        id="olx-account-email"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="vendedor@empresa.com.br"
        value={emailConta}
        onChange={(e) => setEmailConta(e.target.value)}
        disabled={isConnecting}
        className="max-w-sm"
      />
      <p className="text-xs text-muted-foreground">
        É o e-mail com que você entra na OLX. Ele identifica a conta aqui dentro
        e impede que a mesma conta seja conectada duas vezes.
        {jaTemConta && " Preencha para liberar o botão de adicionar."}
      </p>
    </div>
  );

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
            ? "Sua conta da OLX está conectada"
            : "Conecte sua conta da OLX para sincronizar anúncios"}
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
                          {acc.accountName || "Conta OLX"}
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
                          <Label htmlFor={`olx-phone-${acc.id}`}>
                            Telefone do vendedor
                          </Label>
                          <Input
                            id={`olx-phone-${acc.id}`}
                            value={sellerDrafts[acc.id]?.phone ?? ""}
                            onChange={(e) =>
                              setSellerDrafts((prev) => ({
                                ...prev,
                                [acc.id]: {
                                  phone: e.target.value,
                                  zipcode: prev[acc.id]?.zipcode ?? "",
                                },
                              }))
                            }
                            placeholder="11999998888"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`olx-zipcode-${acc.id}`}>
                            CEP do vendedor
                          </Label>
                          <Input
                            id={`olx-zipcode-${acc.id}`}
                            value={sellerDrafts[acc.id]?.zipcode ?? ""}
                            onChange={(e) =>
                              setSellerDrafts((prev) => ({
                                ...prev,
                                [acc.id]: {
                                  phone: prev[acc.id]?.phone ?? "",
                                  zipcode: e.target.value,
                                },
                              }))
                            }
                            placeholder="01001000"
                          />
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleSaveSeller(acc.id)}
                        disabled={savingSellerId === acc.id}
                      >
                        {savingSellerId === acc.id ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Salvando...
                          </>
                        ) : (
                          "Salvar dados do vendedor"
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
              <div className="space-y-3">
                {renderCampoEmailConta(true)}
                <div className="flex gap-2">
                  <Button
                    onClick={handleConnect}
                    disabled={
                      isConnecting || isDisconnecting || !emailContaValido
                    }
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
                          Desconectar todas as contas OLX?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          Esta ação removerá as conexões das contas da OLX. Você
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
                ? "Nenhuma conta da OLX conectada. Solicite ao administrador da conta para conectar."
                : "Ao conectar, você poderá sincronizar automaticamente o estoque dos seus produtos com os anúncios da OLX."}
            </p>
            {!isCollaborator && (
              <div className="space-y-3">
                {renderCampoEmailConta(false)}
                <Button
                  onClick={handleConnect}
                  disabled={
                    isConnecting || !session?.user?.email || !emailContaValido
                  }
                >
                  {isConnecting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Conectando...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Conectar à OLX
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
