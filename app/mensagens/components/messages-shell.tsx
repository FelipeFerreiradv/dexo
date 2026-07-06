"use client";

import * as React from "react";
import { MessageCircle } from "lucide-react";
import { useSession } from "next-auth/react";

import { getApiBaseUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { ConversationList } from "./conversation-list";
import { ChatPane } from "./chat-pane";

export interface AccountSummary {
  id: string;
  accountName: string;
  status: string;
  // Plataforma da conta (MERCADO_LIVRE | MAGALU | ...). Permite badge e o
  // ChatPane decidir o modo de envio (resposta de pergunta vs mensagem de chat).
  platform?: string | null;
}

export interface ConversationSummary {
  externalItemId: string;
  // Conta de origem — usada para o badge e para que o ChatPane chame
  // read/sync/answer na conta correta quando o filtro está em "Todas".
  marketplaceAccountId: string;
  accountName: string | null;
  accountPlatform: string | null;
  productListingId: string | null;
  listingTitle: string | null;
  listingThumbnail: string | null;
  listingPermalink: string | null;
  productSku: string | null;
  buyerNickname: string | null;
  lastQuestionText: string;
  lastQuestionAt: string;
  lastAnswerText: string | null;
  lastAnswerAt: string | null;
  unreadCount: number;
  hasUnanswered: boolean;
}

export type ConversationFilter = "all" | "unanswered" | "unread" | "answered";

interface MessagesShellProps {
  userEmail: string;
}

const POLL_MS = 30_000;

// Magalu (3º marketplace) só entra no filtro com a flag ligada — off ⇒ o
// seletor fica idêntico (só Mercado Livre/Shopee).
const MAGALU_ENABLED =
  process.env.NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED === "true";

const PLATFORM_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "Todas as plataformas" },
  { value: "MERCADO_LIVRE", label: "Mercado Livre" },
  { value: "SHOPEE", label: "Shopee" },
  ...(MAGALU_ENABLED ? [{ value: "MAGALU", label: "Magalu" }] : []),
];

export function MessagesShell({ userEmail }: MessagesShellProps) {
  const apiBase = getApiBaseUrl();
  // Sessão do CLIENTE: a ponte (api-auth-bridge) só popula o Bearer depois que
  // o useSession resolve. Como o primeiro fetch (contas) dispara na MONTAGEM
  // usando o email vindo de prop do servidor, sem isto ele correria à frente da
  // hidratação da sessão e sairia sem Bearer → 401 no modo strict. Anexamos o
  // Bearer explicitamente (memoizado pela STRING do token p/ não re-disparar a
  // cada refetch) e só disparamos os fetches quando a sessão está pronta.
  const { data: session, status } = useSession();
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;
  const isAuthenticated = status === "authenticated";
  const headers = React.useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {};
    if (userEmail) h.email = userEmail; // legado (removível ao virar strict)
    if (apiToken) h.authorization = `Bearer ${apiToken}`;
    return h;
  }, [userEmail, apiToken]);

  const [accounts, setAccounts] = React.useState<AccountSummary[] | null>(null);
  // Default "Todas as contas". Como não há persistência (URL/localStorage),
  // não há seleção salva pra conflitar — abre sempre agregando todas.
  const [accountId, setAccountId] = React.useState<string>("all");
  // Filtro de plataforma (all | MERCADO_LIVRE | SHOPEE | MAGALU).
  const [platform, setPlatform] = React.useState<string>("all");
  const [filter, setFilter] = React.useState<ConversationFilter>("all");
  const [search, setSearch] = React.useState("");
  // debouncedSearch isola digitação: só dispara fetch 250ms após parar de digitar.
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [conversations, setConversations] = React.useState<
    ConversationSummary[] | null
  >(null);
  const [selectedItemId, setSelectedItemId] = React.useState<string | null>(null);
  const [convError, setConvError] = React.useState<string | null>(null);
  // Canal WhatsApp é por PLANO (gate por usuário no backend): a opção do filtro
  // só aparece quando GET /messages/accounts confirmar o entitlement do tenant.
  // Flag global desligada ⇒ o campo nem vem na resposta ⇒ false ⇒ UI idêntica.
  const [whatsappEnabled, setWhatsappEnabled] = React.useState(false);

  React.useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  // Carrega contas — só após a sessão do cliente resolver, garantindo o Bearer.
  React.useEffect(() => {
    if (!isAuthenticated) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${apiBase}/messages/accounts`, {
          headers,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          accounts: AccountSummary[];
          whatsappEnabled?: boolean;
        };
        // Não força mais uma conta específica: o default "all" (estado
        // inicial) faz a aba abrir agregando todas as contas. O usuário
        // troca manualmente no Select se quiser uma conta específica.
        setAccounts(data.accounts);
        setWhatsappEnabled(Boolean(data.whatsappEnabled));
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        console.error("messages: failed to load accounts", err);
        setAccounts([]);
      }
    })();
    return () => controller.abort();
  }, [apiBase, headers, isAuthenticated]);

  const loadConversations = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!isAuthenticated || !accountId) return;
      try {
        const params = new URLSearchParams({
          accountId,
          status: filter,
          ...(platform !== "all" ? { platform } : {}),
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          limit: "50",
        });
        const res = await fetch(
          `${apiBase}/messages/conversations?${params.toString()}`,
          { headers, signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          items: ConversationSummary[];
          total: number;
        };
        setConversations(data.items);
        setConvError(null);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        console.error("messages: failed to load conversations", err);
        setConvError("Não foi possível carregar as conversas. Tente novamente.");
        setConversations([]);
      }
    },
    [accountId, platform, apiBase, filter, headers, debouncedSearch, isAuthenticated],
  );

  // Skeleton (null) só em mudança "dura" — evita flicker em re-fetch por busca/poll.
  React.useEffect(() => {
    setConversations(null);
  }, [accountId, platform, filter]);

  // Carrega conversas + cancela request anterior se inputs mudarem em sequência rápida.
  React.useEffect(() => {
    const controller = new AbortController();
    void loadConversations(controller.signal);
    return () => controller.abort();
  }, [loadConversations]);

  React.useEffect(() => {
    if (!accountId) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void loadConversations();
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [accountId, loadConversations]);

  // Quando muda accountId/filter, limpa seleção se não estiver mais na lista
  React.useEffect(() => {
    if (!conversations) return;
    if (selectedItemId && !conversations.some((c) => c.externalItemId === selectedItemId)) {
      setSelectedItemId(null);
    }
  }, [conversations, selectedItemId]);

  const selectedConversation = React.useMemo(
    () =>
      conversations?.find((c) => c.externalItemId === selectedItemId) ?? null,
    [conversations, selectedItemId],
  );

  // Conta e plataforma combinam (AND); para nunca cair em lista vazia por
  // conflito, escolher um zera o outro (conta específica ⇒ plataforma "todas",
  // e vice-versa).
  const handleSelectAccount = React.useCallback((id: string) => {
    setAccountId(id);
    if (id !== "all") setPlatform("all");
  }, []);
  const handleSelectPlatform = React.useCallback((p: string) => {
    setPlatform(p);
    if (p !== "all") setAccountId("all");
  }, []);

  const onConversationRead = React.useCallback(
    (itemId: string) => {
      setConversations((prev) =>
        prev
          ? prev.map((c) =>
              c.externalItemId === itemId ? { ...c, unreadCount: 0 } : c,
            )
          : prev,
      );
    },
    [],
  );

  // Opções de plataforma: as estáticas + WhatsApp quando o tenant tem o plano.
  const platformOptions = React.useMemo(
    () =>
      whatsappEnabled
        ? [...PLATFORM_OPTIONS, { value: "WHATSAPP", label: "WhatsApp" }]
        : PLATFORM_OPTIONS,
    [whatsappEnabled],
  );

  if (!accounts) {
    return (
      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        <Skeleton className="h-120 rounded-xl" />
        <Skeleton className="h-120 rounded-xl" />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/70 bg-card p-12 text-center">
        <MessageCircle className="h-10 w-10 text-muted-foreground/50" />
        <div className="text-sm font-medium">Nenhuma conta conectada</div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Para começar a receber e responder perguntas e mensagens, conecte uma
          conta em{" "}
          <a
            href="/integracoes/mercado-livre"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Integrações
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={platform} onValueChange={handleSelectPlatform}>
          <SelectTrigger className="h-9 w-48">
            <SelectValue placeholder="Plataforma" />
          </SelectTrigger>
          <SelectContent>
            {platformOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {accounts.length >= 1 && (
          <Select value={accountId} onValueChange={handleSelectAccount}>
            <SelectTrigger className="h-9 w-55">
              <SelectValue placeholder="Conta" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as contas</SelectItem>
              {accounts.map((acc) => (
                <SelectItem key={acc.id} value={acc.id}>
                  {acc.accountName}
                  {acc.status !== "ACTIVE" && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({acc.status.toLowerCase()})
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <FilterTabs value={filter} onChange={setFilter} />
      </div>

      <div
        className={cn(
          "grid h-[calc(100vh-22rem)] min-h-130 gap-4 overflow-hidden",
          "md:grid-cols-[minmax(280px,360px)_1fr]",
        )}
      >
        <ConversationList
          conversations={conversations}
          selectedItemId={selectedItemId}
          onSelect={setSelectedItemId}
          search={search}
          onSearchChange={setSearch}
          error={convError}
          className={cn(selectedItemId && "hidden md:flex")}
        />
        <ChatPane
          apiBase={apiBase}
          headers={headers}
          accountId={accountId}
          conversation={selectedConversation}
          onBack={() => setSelectedItemId(null)}
          onAfterRead={onConversationRead}
          onAfterAnswer={() => void loadConversations()}
          className={cn(!selectedItemId && "hidden md:flex")}
        />
      </div>
    </div>
  );
}

function FilterTabs({
  value,
  onChange,
}: {
  value: ConversationFilter;
  onChange: (v: ConversationFilter) => void;
}) {
  const options: { id: ConversationFilter; label: string }[] = [
    { id: "all", label: "Todas" },
    { id: "unanswered", label: "Sem resposta" },
    { id: "unread", label: "Não lidas" },
    { id: "answered", label: "Respondidas" },
  ];
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card p-1">
      {options.map((opt) => (
        <Button
          key={opt.id}
          type="button"
          size="sm"
          variant={value === opt.id ? "default" : "ghost"}
          onClick={() => onChange(opt.id)}
          className="h-7 rounded-full px-3 text-xs"
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
