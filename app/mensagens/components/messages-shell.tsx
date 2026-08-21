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
import { notifyUnreadChanged } from "../lib/unread-events";
import {
  aplicarLeiturasConfirmadas,
  mesclarPagina0,
  podarLeiturasAntigas,
  resolverConversaAberta,
} from "../lib/conversation-merge";

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

/** Tamanho da página. O backend limita `limit` a 100. */
const PAGE_SIZE = 50;

/**
 * "reset" = primeira carga/troca de filtro · "poll" = ciclo de 30 s ·
 * "mais" = botão Carregar mais (única que usa offset).
 */
type ModoCarga = "reset" | "mais" | "poll";

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
  // Total de conversas no servidor (o backend já devolvia; a UI ignorava). Sem
  // isto não havia como alcançar nada além da 50ª — no maior tenant eram 1.297
  // conversas com não lidas contra 50 exibidas.
  const [total, setTotal] = React.useState(0);
  const [carregandoMais, setCarregandoMais] = React.useState(false);
  const [paginasCarregadas, setPaginasCarregadas] = React.useState(1);
  // Contexto = o recorte que a lista representa. Serve para saber se a lista na
  // tela já é do filtro atual antes de decidir que a conversa aberta "sumiu".
  const contextoAtual = `${accountId}|${platform}|${filter}`;
  const [contextoDaLista, setContextoDaLista] = React.useState<string | null>(
    null,
  );
  // Uma conferência de seleção por troca de contexto (não a cada poll).
  const conferirSelecaoRef = React.useRef(true);
  // Última versão conhecida da conversa aberta — mantém o painel de pé quando a
  // lista filtrada deixa de trazê-la.
  const ultimaConversaRef = React.useRef<ConversationSummary | null>(null);
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

  // Guarda de corrida: só a resposta da requisição MAIS RECENTE pode escrever no
  // estado. Havia três disparadores de refetch (efeito, poll de 30 s e
  // pós-resposta) e dois deles rodavam sem AbortController, então uma resposta
  // antiga podia chegar depois de uma leitura confirmada e ressuscitar o número.
  const seqRef = React.useRef(0);
  // Leituras JÁ CONFIRMADAS pelo servidor: itemId -> instante da confirmação.
  // Uma resposta cuja requisição começou ANTES da confirmação está proibida de
  // sobrescrever o zero; uma que começou depois já reflete o pós-leitura.
  const readAckRef = React.useRef<Map<string, number>>(new Map());

  const loadConversations = React.useCallback(
    async (
      signal?: AbortSignal,
      modo: ModoCarga = "reset",
      offset = 0,
    ) => {
      if (!isAuthenticated || !accountId) return;
      const seq = ++seqRef.current;
      const iniciadoEm = Date.now();
      // O recorte que ESTA requisição representa (vem do closure, não do render
      // atual) — é o que marca a lista como já pertencente ao contexto novo.
      const contextoDoRequest = `${accountId}|${platform}|${filter}`;
      if (modo === "mais") setCarregandoMais(true);
      try {
        const params = new URLSearchParams({
          accountId,
          status: filter,
          ...(platform !== "all" ? { platform } : {}),
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          limit: String(PAGE_SIZE),
          // "reset" e "poll" sempre pedem a PRIMEIRA página: a ordenação é por
          // data da última mensagem, então novidade cai sempre ali. Recarregar
          // todas as páginas abertas a cada 30 s multiplicaria o egress sem ganho.
          ...(modo === "mais" && offset > 0 ? { offset: String(offset) } : {}),
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
        if (seq !== seqRef.current) return; // resposta obsoleta: descarta
        podarLeiturasAntigas(readAckRef.current);
        const recebidas = aplicarLeiturasConfirmadas(
          data.items,
          readAckRef.current,
          iniciadoEm,
        );
        setTotal(data.total);
        setContextoDaLista(contextoDoRequest);
        setConversations((prev) => {
          if (modo === "mais") return [...(prev ?? []), ...recebidas];
          // "reset" SEMPRE substitui: troca de filtro, de conta ou de busca não
          // pode mesclar a lista nova com a antiga.
          if (modo === "reset") return recebidas;
          // "poll": sem páginas extras abertas, substitui a lista inteira —
          // byte-idêntico ao comportamento anterior à paginação, que é o caso de
          // quem nunca clicou em "Carregar mais".
          if (!prev || prev.length <= PAGE_SIZE) return recebidas;
          return mesclarPagina0(prev, recebidas);
        });
        // O contador de páginas tem de acompanhar o que está NA LISTA, senão o
        // próximo "Carregar mais" pede um offset que pula registros.
        if (modo === "mais") setPaginasCarregadas((p) => p + 1);
        else if (modo === "reset") setPaginasCarregadas(1);
        setConvError(null);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        // Falha obsoleta também não pode apagar a lista que já está na tela.
        if (seq !== seqRef.current) return;
        console.error("messages: failed to load conversations", err);
        // Falhar ao buscar a PRÓXIMA página não pode derrubar o que já está na
        // tela: só a carga inicial esvazia a lista.
        if (modo === "mais") return;
        setConvError("Não foi possível carregar as conversas. Tente novamente.");
        setConversations([]);
      } finally {
        if (modo === "mais") setCarregandoMais(false);
      }
    },
    [accountId, platform, apiBase, filter, headers, debouncedSearch, isAuthenticated],
  );

  // O offset vem do número de PÁGINAS já pedidas, não de `conversations.length`:
  // o merge do poll pode deixar na lista conversas que saíram da página 0, e usar
  // o comprimento como offset faria a próxima página pular registros.
  const carregarMais = React.useCallback(() => {
    void loadConversations(undefined, "mais", paginasCarregadas * PAGE_SIZE);
  }, [loadConversations, paginasCarregadas]);

  // Skeleton (null) só em mudança "dura" — evita flicker em re-fetch por busca/poll.
  React.useEffect(() => {
    setConversations(null);
    setContextoDaLista(null);
    setTotal(0);
    setPaginasCarregadas(1);
    // Trocou o recorte: a seleção volta a ser conferida uma vez, contra a lista
    // nova (e só ela — ver o efeito de fechamento do painel).
    conferirSelecaoRef.current = true;
  }, [accountId, platform, filter]);

  // A busca não zera a lista (evita flicker ao digitar), mas volta a paginação
  // ao início: o resultado filtrado é outro conjunto, com outro offset.
  React.useEffect(() => {
    setPaginasCarregadas(1);
  }, [debouncedSearch]);

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
        void loadConversations(undefined, "poll");
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [accountId, loadConversations]);

  // Fecha o painel quando a conversa aberta sai do ESCOPO — e só então.
  //
  // Antes, este efeito dependia de `conversations` e rodava a cada atualização
  // da lista, inclusive no poll de 30 s. Na aba "Não lidas" isso fechava o
  // painel na cara de quem estava lendo: marcar a conversa como lida a remove
  // do resultado filtrado, e a ausência era lida como "saiu do escopo". Em
  // "Sem resposta", responder produzia o mesmo efeito.
  //
  // Agora a conferência acontece UMA vez por troca de contexto, e só contra uma
  // lista que já é daquele contexto (`contextoDaLista`) — enquanto a lista ainda
  // é do contexto anterior, ou está carregando, a ausência não significa nada.
  React.useEffect(() => {
    if (!conversations || contextoDaLista !== contextoAtual) return;
    if (!conferirSelecaoRef.current) return;
    conferirSelecaoRef.current = false;
    if (
      selectedItemId &&
      !conversations.some((c) => c.externalItemId === selectedItemId)
    ) {
      setSelectedItemId(null);
    }
  }, [conversations, contextoDaLista, contextoAtual, selectedItemId]);

  const selectedConversation = React.useMemo(
    () =>
      resolverConversaAberta(
        selectedItemId,
        conversations,
        ultimaConversaRef.current,
      ),
    [conversations, selectedItemId],
  );

  // Guarda a versão fresca sempre que a lista ainda traz a conversa aberta. Em
  // efeito (não no render) para o useMemo continuar puro.
  React.useEffect(() => {
    if (selectedConversation) ultimaConversaRef.current = selectedConversation;
  }, [selectedConversation]);

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

  // Chamado pelo ChatPane APÓS o servidor confirmar a leitura (2xx) — nunca de
  // forma otimista.
  const onConversationRead = React.useCallback(
    (itemId: string) => {
      // Carimba a confirmação: é isto que autoriza o zero a sobreviver a um
      // refetch que já estava em voo quando a leitura aconteceu.
      readAckRef.current.set(itemId, Date.now());
      setConversations((prev) =>
        prev
          ? prev.map((c) =>
              c.externalItemId === itemId ? { ...c, unreadCount: 0 } : c,
            )
          : prev,
      );
      // O badge da sidebar tem poll próprio de 60 s: avisa para revalidar já,
      // em vez de deixar o número velho até um minuto na tela.
      notifyUnreadChanged();
    },
    [],
  );

  // Responder já marca a conversa como lida no SERVIDOR (MessagesUseCase), então
  // aqui só carimbamos a confirmação e revalidamos as duas contagens.
  const handleAfterAnswer = React.useCallback(() => {
    if (selectedItemId) readAckRef.current.set(selectedItemId, Date.now());
    notifyUnreadChanged();
    // "poll", não "reset": responder é uma atualização da visão atual, não uma
    // troca de recorte — não pode colapsar as páginas que o usuário já abriu.
    void loadConversations(undefined, "poll");
  }, [loadConversations, selectedItemId]);

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
          hasMore={Boolean(conversations && total > conversations.length)}
          loadingMore={carregandoMais}
          onLoadMore={carregarMais}
          className={cn(selectedItemId && "hidden md:flex")}
        />
        <ChatPane
          apiBase={apiBase}
          headers={headers}
          accountId={accountId}
          conversation={selectedConversation}
          onBack={() => setSelectedItemId(null)}
          onAfterRead={onConversationRead}
          onAfterAnswer={handleAfterAnswer}
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
