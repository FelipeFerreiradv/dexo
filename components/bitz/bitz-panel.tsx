"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Maximize2, Minimize2, PenSquare, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBitzChat } from "@/hooks/use-bitz-chat";
import { useBitzAnexo } from "@/hooks/use-bitz-anexo";
import { useBitzAudio } from "@/hooks/use-bitz-audio";
import { useBitzCapacidades } from "@/hooks/use-bitz-capacidades";
import { BitzAnexo } from "./bitz-anexo";
import { BitzApresentacao } from "./bitz-apresentacao";
import { BitzComposer } from "./bitz-composer";
import { BitzEscuta } from "./bitz-escuta";
import { BitzEmptyState } from "./bitz-empty-state";
import { BitzMascot } from "./bitz-mascot";
import { BitzMessage, BitzStreaming, BitzThinking } from "./bitz-message";
import { jaPassou, marcarPassou } from "./bitz-onboarding";
import type { BitzPanelMode } from "./bitz-constants";

interface BitzPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: BitzPanelMode;
  onModeChange: (mode: BitzPanelMode) => void;
  userName?: string | null;
  /** Chave do marco de apresentação. Ver `bitz-onboarding.ts`. */
  usuarioId: string;
}

/**
 * Painel do Bitz.
 *
 * DOIS MODOS, e o full-screen está disponível em QUALQUER tela:
 *  - `docked`     — cartão ancorado no canto inferior direito (desktop).
 *                   Radix com `modal={false}`: sem trava de scroll e sem
 *                   bloquear clique fora, então dá para continuar trabalhando
 *                   na página com o Bitz aberto ao lado.
 *  - `fullscreen` — ocupa a viewport inteira, em desktop e em mobile.
 *                   `modal={true}`: trava de foco, Esc, scroll lock. É o modo
 *                   da referência de design e o padrão no celular.
 *
 * Por que primitivo do Radix e não `components/ui/dialog.tsx`: o DialogContent
 * da casa traz X embutido, régua dourada no ::before e `sm:max-w-lg`, que eu
 * teria que desfazer. Usando o primitivo direto ganho portal, foco e Esc de
 * graça SEM tocar em arquivo existente.
 *
 * Z-INDEX (mapeado no diagnóstico da Fase 0):
 *   toasts z-[100] > Radix/header z-50 > BITZ > busca da sidebar z-30
 *   - docked usa z-40: acima de todo conteúdo em árvore, abaixo de todo modal
 *     e de todo toast.
 *   - fullscreen usa z-50: ali ele É o modal da vez e precisa cobrir o header
 *     sticky. Continua abaixo dos toasts (z-[100]), que é o correto — um aviso
 *     de "produto salvo" tem que aparecer por cima.
 */
export function BitzPanel({
  open,
  onOpenChange,
  mode,
  onModeChange,
  userName,
  usuarioId,
}: BitzPanelProps) {
  const { messages, pending, streaming, send, reset, decidirAcao } =
    useBitzChat();
  const [draft, setDraft] = React.useState("");

  // Microfone e clipe só existem se o servidor disser que sabe fazer aquilo.
  const { audio: audioDisponivel, anexos: extensoesAceitas } =
    useBitzCapacidades(open);

  /**
   * ⭐ A LEITURA DO ANEXO CAI NUM CARTÃO, NÃO NA CONVERSA — e é o mesmo motivo
   * da transcrição. O lojista vê o que o Bitz entendeu da foto ANTES de
   * perguntar, e corrige o código que veio errado. Mandar direto pouparia um
   * toque e custaria caro: uma leitura errada viraria uma resposta certa sobre a
   * peça errada.
   */
  const anexo = useBitzAnexo();

  /**
   * ⭐ A TRANSCRIÇÃO CAI NO CAMPO, NÃO NA CONVERSA.
   *
   * O lojista lê o que saiu, corrige "cubo de roda" que virou "cubo de rodas",
   * e só então envia. Mandar direto pouparia um toque e custaria caro: uma
   * transcrição errada viraria uma pergunta que ele não fez, gastando uma
   * mensagem da cota do dia dele.
   */
  const voz = useBitzAudio({
    onTexto: (texto) => setDraft((atual) => (atual ? `${atual} ${texto}` : texto)),
  });
  const escutando = voz.estado === "gravando" || voz.estado === "enviando";
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * Ref CALLBACK do container de rolagem, e não um `useRef` puro.
   *
   * ⚠️ O BUG QUE ISTO CORRIGE: fechar e reabrir o chat devolvia a conversa ao
   * TOPO. O `DialogPrimitive.Content` do Radix é envolvido em
   * `Presence present={forceMount || open}` — sem `forceMount`, fechar RETIRA o
   * container do DOM. Ao reabrir, o nó é NOVO e nasce com `scrollTop = 0`, mas
   * o efeito de autoscroll abaixo não roda: as dependências dele (`messages`,
   * `pending`, `streaming`) têm identidade estável entre fechar e abrir. O
   * usuário voltava para a primeira mensagem de uma conversa longa.
   *
   * Um callback resolve na raiz: ele é chamado no instante em que o nó ENTRA no
   * DOM, seja qual for o motivo da remontagem — hoje o Radix, amanhã outra
   * coisa. Nesse ponto os filhos já estão montados (React anexa refs de baixo
   * para cima), então `scrollHeight` já é o final.
   *
   * ⚠️ `useCallback` COM LISTA VAZIA é obrigatório. Uma arrow inline teria
   * identidade nova a cada render, e o React desanexaria/reanexaria o ref em
   * TODO render — jogando a conversa para o fim enquanto o usuário tenta ler
   * uma mensagem antiga lá em cima. O teste prende isso.
   */
  const fixarRolagem = React.useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const isFull = mode === "fullscreen";
  const vazio = messages.length === 0;

  /**
   * A tela "Conheça o Bitz" só existe na PRIMEIRA conversa de todas.
   *
   * ⭐ Lido no inicializador, e não num `useEffect`, de propósito: este painel é
   * carregado com `ssr: false` (bitz-widget.tsx), então não há render de
   * servidor com que divergir — e um efeito faria a tela de boas-vindas normal
   * piscar por um quadro antes de ser substituída.
   */
  const [apresentar, setApresentar] = React.useState(
    () => typeof window !== "undefined" && !jaPassou(usuarioId, "apresentacao"),
  );

  /**
   * A ÚNICA saída da apresentação é a primeira mensagem.
   *
   * ⭐ O pedido foi literal: a tela vale "até a pessoa enviar sua primeira
   * mensagem". Não há botão paralelo — a referência de design tem um "Get
   * started", mas aqui ele faria a mesma coisa que o campo de texto logo
   * abaixo, e mais um caminho para o mesmo lugar só dá mais um estado para
   * errar.
   */
  const encerrarApresentacao = React.useCallback(() => {
    marcarPassou(usuarioId, "apresentacao");
    setApresentar(false);
  }, [usuarioId]);

  /**
   * A apresentação está NO AR neste instante.
   *
   * Governa duas coisas ao mesmo tempo — o cabeçalho sumir e o bloco ocupar a
   * altura toda —, e por isso vale a variável: as duas condições têm que mudar
   * juntas, senão sobra barra sem conteúdo ou conteúdo sem espaço.
   */
  const apresentando = vazio && apresentar;

  // Autoscroll para o fim quando a CONVERSA anda. Mesmo padrão de
  // app/mensagens/.../chat-pane.tsx:165 — o projeto não tem primitivo
  // `scroll-area`, e a convenção é overflow-y com scrollTop manual.
  //
  // Continua necessário ao lado do `fixarRolagem`: aquele cobre a MONTAGEM do
  // container, este cobre mensagem nova e texto chegando ao vivo, que acontecem
  // com o mesmo nó no DOM.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, streaming?.content]);

  const perguntar = (texto: string) => {
    setDraft("");
    // A primeira mensagem encerra a apresentação para sempre — inclusive quando
    // ela é enviada direto do composer, sem passar pelo botão da tela.
    if (apresentar) encerrarApresentacao();

    // O anexo vai JUNTO desta pergunta e sai da mesa. Deixá-lo grudado colaria
    // a mesma foto em toda pergunta seguinte da conversa — e o lojista pagaria
    // o contexto dela sem nunca ter pedido.
    const enviado = anexo.anexo;
    anexo.remover();

    void send(
      texto,
      enviado
        ? [
            {
              nome: enviado.nome,
              tipo: enviado.tipo,
              leitura: enviado.leitura,
            },
          ]
        : undefined,
    );
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={onOpenChange}
      modal={isFull}
    >
      <DialogPrimitive.Portal>
        {isFull && (
          <DialogPrimitive.Overlay
            className={cn(
              "fixed inset-0 z-50 bg-[#0e1f2a]/55 backdrop-blur-[2px]",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
              "motion-reduce:animate-none",
            )}
          />
        )}

        <DialogPrimitive.Content
          aria-describedby={undefined}
          onInteractOutside={(e) => {
            // No modo docado o clique fora é do usuário trabalhando na página,
            // não um pedido para fechar o chat.
            if (!isFull) e.preventDefault();
          }}
          className={cn(
            "bg-background text-foreground fixed flex flex-col overflow-hidden shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "motion-reduce:animate-none",
            isFull
              ? "inset-0 z-50 rounded-none"
              : cn(
                  "z-40 rounded-3xl border",
                  "border-border/60",
                  // Mobile sem full-screen explícito ainda respira: quase toda
                  // a tela, mas livrando a faixa de toasts embaixo.
                  "inset-x-3 bottom-3 top-20",
                  // Desktop: cartão ancorado no canto.
                  "md:inset-auto md:right-6 md:bottom-6 md:top-auto",
                  "md:h-[min(46rem,calc(100svh-7rem))] md:w-[26.5rem]",
                ),
          )}
        >
          {/* Lavagem de gradiente — a leitura "glass" da referência, feita com
              os tokens da marca em vez do lavanda. Puramente decorativa. */}
          <div
            aria-hidden
            className="from-primary/10 pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b to-transparent"
          />

          {/* ⭐ NA APRESENTAÇÃO NÃO HÁ CABEÇALHO. A primeira tela do produto é a
              primeira impressão dele e não divide espaço com barra de título,
              expandir ou nova conversa — a barra volta assim que a conversa
              começa.

              ⚠️ O `<Title>` do Radix NÃO pode sumir junto: sem ele o diálogo
              perde o nome acessível e a biblioteca reclama em dev. Ele continua
              montado, apenas fora da tela (`sr-only`). */}
          {apresentando ? (
            <DialogPrimitive.Title className="sr-only">
              Bitz — assistente do Dexo
            </DialogPrimitive.Title>
          ) : (
            <header className="relative flex shrink-0 items-center gap-2.5 px-3.5 py-3">
              {/* Régua que nasce e morre em transparente, em vez de um
                  `border-b` batendo nas duas paredes. */}
              <div
                aria-hidden
                className="via-border absolute inset-x-3 bottom-0 h-px bg-gradient-to-r from-transparent to-transparent"
              />
              <BitzMascot size={32} aura priority />
              <div className="min-w-0 flex-1">
                {/* Mesmo wordmark do herói das páginas e da apresentação:
                    Outfit, font-black, minúsculas, ponto em amarelo. */}
                <DialogPrimitive.Title
                  className="text-foreground text-lg leading-none font-black tracking-[-0.04em] lowercase select-none"
                  style={{ fontFamily: "var(--font-outfit)" }}
                >
                  bitz<span className="text-primary">.</span>
                </DialogPrimitive.Title>
                <p className="text-muted-foreground mt-1 truncate font-mono text-[9px] tracking-[0.18em] uppercase">
                  Assistente do Dexo
                </p>
              </div>

              {!vazio && (
                <IconBtn
                  label="Nova conversa"
                  onClick={() => {
                    reset();
                    setDraft("");
                  }}
                >
                  <PenSquare className="size-4" />
                </IconBtn>
              )}

              <IconBtn
                label={isFull ? "Reduzir" : "Expandir para tela cheia"}
                onClick={() => onModeChange(isFull ? "docked" : "fullscreen")}
              >
                {isFull ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </IconBtn>

              <DialogPrimitive.Close asChild>
                <IconBtn label="Fechar">
                  <X className="size-4" />
                </IconBtn>
              </DialogPrimitive.Close>
            </header>
          )}

          <div
            ref={fixarRolagem}
            className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          >
            {/* Em tela cheia a conversa ganha uma coluna legível no centro em
                vez de esticar por 2000px de monitor.

                ⭐ `flex min-h-full flex-col` durante a apresentação: sem isso o
                bloco fica colado no topo e sobra um vão entre o robô e o
                composer, quando o desenho pede exatamente o contrário — o robô
                logo acima da caixa de texto.

                ⚠️ AS DUAS PARTES SÃO NECESSÁRIAS, e só `min-h-full` não basta.
                O `min-h-full` funciona AQUI porque este é filho DIRETO do
                container de rolagem, que tem altura definida (`flex-1
                min-h-0`). Mas a altura DESTE div continua `auto`, então um
                `min-h-full` na tela filha resolveria contra um pai indefinido e
                viraria zero. É o `flex flex-col` que dá à filha (com `flex-1`)
                a altura toda para se centralizar dentro. */}
            <div
              className={cn(
                "mx-auto w-full",
                isFull && "max-w-3xl",
                apresentando && "flex min-h-full flex-col",
              )}
            >
              {vazio ? (
                // ⭐ Primeira conversa de todas: a apresentação. Depois dela —
                // e em toda "nova conversa" — a tela de boas-vindas de sempre,
                // com sugestões e exemplos. Apresentar duas vezes seria
                // apresentar a quem já conhece.
                apresentar ? (
                  <BitzApresentacao
                    nome={userName}
                    onFechar={() => onOpenChange(false)}
                  />
                ) : (
                  <BitzEmptyState nome={userName} onPergunta={perguntar} />
                )
              ) : (
                <div className="flex flex-col gap-3 p-4">
                  {messages.map((m) => (
                    <BitzMessage
                      key={m.id}
                      message={m}
                      aoDecidirAcao={decidirAcao}
                    />
                  ))}
                  {/* Enquanto o turno corre: o texto ao vivo quando já há
                      texto, o indicador de consulta quando o Bitz foi ao
                      banco, e os três pontinhos no resto do tempo. A bolha
                      definitiva substitui isto quando o quadro `fim` chega. */}
                  {pending &&
                    (streaming ? (
                      <BitzStreaming
                        content={streaming.content}
                        consultando={streaming.consultando}
                      />
                    ) : (
                      <BitzThinking />
                    ))}
                </div>
              )}
            </div>
          </div>

          <div className={cn("mx-auto w-full shrink-0", isFull && "max-w-3xl")}>
            {/* Os erros do microfone e do clipe vivem AQUI, colados no
                composer, e não num toast: o caminho de saída ("pode escrever a
                pergunta") é o campo logo abaixo. Um toast some antes de o
                lojista ler. */}
            {voz.erro && <Aviso texto={voz.erro} onOk={voz.limparErro} />}
            {anexo.erro && (
              <Aviso texto={anexo.erro} onOk={anexo.limparErro} />
            )}

            {/* O que o Bitz leu do arquivo, para conferência, entre a conversa
                e o campo de escrita. */}
            <BitzAnexo
              anexo={anexo.anexo}
              lendo={anexo.estado === "lendo"}
              onRemover={anexo.remover}
            />

            <BitzComposer
              value={draft}
              onValueChange={setDraft}
              onSend={perguntar}
              disabled={pending}
              autoFocus={open}
              onMicrofone={audioDisponivel ? voz.gravar : undefined}
              onArquivo={anexo.escolher}
              aceita={extensoesAceitas}
              temAnexo={!!anexo.anexo}
              aguardandoAnexo={anexo.estado === "lendo"}
            />
          </div>

          {/* Enquanto grava, a escuta cobre o painel inteiro. Ver bitz-escuta. */}
          {escutando && (
            <BitzEscuta
              estado={voz.estado}
              segundos={voz.segundos}
              maxSegundos={voz.maxSegundos}
              onParar={voz.parar}
              onCancelar={voz.cancelar}
            />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Aviso colado no composer. `role="alert"` para o leitor de tela anunciar sem
 * o usuário precisar procurar — quem grava um áudio ou anexa uma foto está
 * olhando para o painel, não para o canto da tela.
 */
function Aviso({ texto, onOk }: { texto: string; onOk: () => void }) {
  return (
    <div className="px-3 pt-3">
      <p
        role="alert"
        className="border-destructive/40 bg-destructive/10 text-foreground flex items-start gap-2 rounded-2xl border px-3 py-2 text-xs"
      >
        <span className="flex-1">{texto}</span>
        <button
          type="button"
          onClick={onOk}
          className="text-muted-foreground hover:text-foreground shrink-0 underline"
        >
          ok
        </button>
      </p>
    </div>
  );
}

const IconBtn = React.forwardRef<
  HTMLButtonElement,
  { label: string; children: React.ReactNode; onClick?: () => void }
>(function IconBtn({ label, children, onClick, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-8 shrink-0 items-center justify-center rounded-full",
        "transition hover:scale-105 active:scale-95",
        "motion-reduce:transition-none motion-reduce:hover:scale-100",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export default BitzPanel;
