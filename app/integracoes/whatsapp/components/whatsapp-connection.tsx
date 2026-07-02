"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Unplug,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiBaseUrl, authHeaders } from "@/lib/api";
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

interface WhatsappAccount {
  id: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  status: string;
  createdAt: string;
}

const EMPTY_FORM = {
  phoneNumberId: "",
  wabaId: "",
  accessToken: "",
  appId: "",
  appSecret: "",
};

export function WhatsappConnection() {
  const { data: session, status: sessionStatus } = useSession();
  // Colaboradores visualizam, mas conectar/desconectar é do administrador
  // (mesma regra das conexões de marketplace).
  const isCollaborator = Boolean((session?.user as any)?.parentUserId);
  const apiBase = getApiBaseUrl();
  const headers = useMemo(
    () => authHeaders(session as any),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.user?.email, (session as any)?.apiToken],
  );

  // null = sonda em andamento; false = tenant sem o módulo (plano) — a página
  // vira o aviso de upgrade; true = habilitado.
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<WhatsappAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [connecting, setConnecting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/whatsapp/accounts`, { headers });
      if (res.status === 403) {
        setEntitled(false);
        return;
      }
      if (!res.ok) throw new Error("Erro ao listar números conectados");
      const data = await res.json();
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
      setAccounts([]);
    }
  }, [apiBase, headers]);

  // Sonda de entitlement (plano) e carga inicial.
  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/whatsapp/status`, { headers });
        if (!res.ok) throw new Error("Erro ao verificar acesso ao módulo");
        const data = await res.json();
        if (cancelled) return;
        setEntitled(Boolean(data.enabled));
        if (data.enabled) await loadAccounts();
      } catch (err) {
        if (cancelled) return;
        setEntitled(false);
        setError(err instanceof Error ? err.message : "Erro desconhecido");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, headers, loadAccounts, sessionStatus]);

  const handleConnect = async () => {
    setError(null);
    setNotice(null);
    if (!form.phoneNumberId.trim() || !form.wabaId.trim() || !form.accessToken.trim()) {
      setError("Preencha phone number ID, WABA ID e o token de acesso.");
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch(`${apiBase}/whatsapp/accounts`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumberId: form.phoneNumberId.trim(),
          wabaId: form.wabaId.trim(),
          accessToken: form.accessToken.trim(),
          appId: form.appId.trim() || undefined,
          appSecret: form.appSecret.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "Erro ao conectar o número");
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      setNotice(
        data?.webhookSubscribed
          ? "Número conectado e webhooks assinados com sucesso."
          : `Número conectado, mas a assinatura de webhooks falhou (${data?.webhookError ?? "motivo desconhecido"}). Use "Testar" após revisar o app na Meta.`,
      );
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao conectar");
    } finally {
      setConnecting(false);
    }
  };

  const handleTest = async (accountId: string) => {
    setError(null);
    setNotice(null);
    setTestingId(accountId);
    try {
      const res = await fetch(
        `${apiBase}/whatsapp/accounts/${encodeURIComponent(accountId)}/test`,
        { method: "POST", headers },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Erro ao testar conexão");
      if (data.ok) {
        setNotice("Conexão OK — token válido e número ativo na Meta.");
      } else {
        setError(
          data.authError
            ? `Token inválido/revogado — conta marcada com erro. Reconecte o número. (${data.error})`
            : `Falha no teste (sem mudar o status): ${data.error}`,
        );
      }
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao testar");
    } finally {
      setTestingId(null);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    setError(null);
    setNotice(null);
    setDisconnectingId(accountId);
    try {
      const res = await fetch(
        `${apiBase}/whatsapp/accounts/${encodeURIComponent(accountId)}`,
        { method: "DELETE", headers },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Erro ao desconectar");
      setNotice("Número desconectado.");
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao desconectar");
    } finally {
      setDisconnectingId(null);
    }
  };

  if (sessionStatus === "loading" || entitled === null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Verificando acesso ao módulo...
        </CardContent>
      </Card>
    );
  }

  // Tenant sem o módulo no plano: aviso de upgrade, zero funcionalidade.
  if (!entitled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-muted-foreground" />
            Recurso do plano superior
          </CardTitle>
          <CardDescription>
            O atendimento por WhatsApp não está incluído no seu plano atual.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Com o módulo de WhatsApp você conecta vários números da sua empresa
            e responde todas as conversas direto pela aba de Mensagens do Dexo.
            Fale com o suporte para habilitar.
          </p>
        </CardContent>
      </Card>
    );
  }

  const webhookUrl = `${apiBase}/whatsapp/webhook`;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {accounts && accounts.length > 0 ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <XCircle className="h-5 w-5 text-muted-foreground" />
            )}
            Números conectados
          </CardTitle>
          <CardDescription>
            {accounts && accounts.length > 0
              ? "As conversas destes números aparecem na aba de Mensagens."
              : "Conecte o primeiro número do WhatsApp Business (Cloud API)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
              {notice}
            </div>
          )}

          {accounts === null ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando números...
            </div>
          ) : (
            <div className="space-y-2">
              {accounts.map((acc) => {
                const isError = acc.status === "ERROR";
                return (
                  <div
                    key={acc.id}
                    className="relative flex items-center justify-between gap-3 overflow-hidden rounded-lg border border-border/60 bg-card p-3"
                  >
                    <span
                      className={`absolute inset-y-0 left-0 w-1 ${isError ? "bg-destructive" : "bg-emerald-500"}`}
                      aria-hidden
                    />
                    <div className="min-w-0 space-y-1.5 pl-1.5">
                      <div className="flex items-center gap-2">
                        {isError ? (
                          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        )}
                        <span className="truncate font-semibold [font-family:var(--font-bricolage)]">
                          {acc.verifiedName || acc.displayPhoneNumber}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {acc.displayPhoneNumber}
                        </span>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${
                            isError
                              ? "bg-destructive/10 text-destructive"
                              : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                          }`}
                        >
                          {isError ? "Erro de conexão" : acc.status}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTest(acc.id)}
                        disabled={testingId === acc.id}
                      >
                        {testingId === acc.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-2 h-4 w-4" />
                        )}
                        Testar
                      </Button>
                      {!isCollaborator && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={disconnectingId === acc.id}
                            >
                              {disconnectingId === acc.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Unplug className="mr-2 h-4 w-4" />
                              )}
                              Desconectar
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Desconectar {acc.displayPhoneNumber}?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                As conversas e mensagens deste número serão
                                removidas do Dexo (o histórico continua no
                                WhatsApp do celular). Esta ação não pode ser
                                desfeita.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDisconnect(acc.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Desconectar
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                );
              })}
              {accounts.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nenhum número conectado ainda.
                </p>
              )}
            </div>
          )}

          {!isCollaborator && !showForm && (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Conectar número
            </Button>
          )}
          {isCollaborator && (
            <p className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
              A gestão dos números de WhatsApp é feita pelo administrador da
              conta. Você pode atender as conversas pela aba de Mensagens.
            </p>
          )}

          {showForm && !isCollaborator && (
            <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">
                  Conectar número (Cloud API)
                </p>
                <p className="text-xs text-muted-foreground">
                  Dados do painel da Meta (developers.facebook.com → seu app →
                  WhatsApp → API Setup). O token deve ser permanente (System
                  User) com as permissões de WhatsApp Business.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wa-phone-id">Phone number ID *</Label>
                  <Input
                    id="wa-phone-id"
                    value={form.phoneNumberId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, phoneNumberId: e.target.value }))
                    }
                    placeholder="ex.: 106540352242922"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-waba-id">WABA ID *</Label>
                  <Input
                    id="wa-waba-id"
                    value={form.wabaId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, wabaId: e.target.value }))
                    }
                    placeholder="ID da WhatsApp Business Account"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="wa-token">Token de acesso *</Label>
                  <Input
                    id="wa-token"
                    type="password"
                    value={form.accessToken}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, accessToken: e.target.value }))
                    }
                    placeholder="Token permanente (System User)"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-app-id">App ID (opcional)</Label>
                  <Input
                    id="wa-app-id"
                    value={form.appId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, appId: e.target.value }))
                    }
                    placeholder="App Meta do cliente"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-app-secret">App Secret (opcional)</Label>
                  <Input
                    id="wa-app-secret"
                    type="password"
                    value={form.appSecret}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, appSecret: e.target.value }))
                    }
                    placeholder="Valida a assinatura dos webhooks"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleConnect} disabled={connecting}>
                  {connecting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Validando na Meta...
                    </>
                  ) : (
                    "Conectar"
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowForm(false);
                    setForm(EMPTY_FORM);
                  }}
                  disabled={connecting}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuração do webhook</CardTitle>
          <CardDescription>
            No app da Meta (WhatsApp → Configuration → Webhooks), aponte o
            Callback URL para o endereço abaixo. O verify token é fornecido
            pelo suporte do Dexo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
            {webhookUrl}
          </code>
          <p className="mt-2 text-xs text-muted-foreground">
            Campo de webhook a assinar: <span className="font-mono">messages</span>.
            Sem o webhook configurado, as mensagens recebidas não chegam ao Dexo.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
