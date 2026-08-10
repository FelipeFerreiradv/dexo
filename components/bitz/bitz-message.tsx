"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, ImageIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { BitzChatMessage } from "@/hooks/use-bitz-chat";
import { BitzMascot } from "./bitz-mascot";
import { BitzSources } from "./bitz-sources";

/**
 * Renderiza markdown do assistente.
 *
 * SEM `rehype-raw`: HTML cru fica desabilitado de propósito. A saída do modelo
 * é conteúdo não confiável e habilitar HTML ali abriria injeção de markup na
 * página do ERP. O `react-markdown` escapa HTML por padrão — a defesa é não
 * desligar isso.
 *
 * Tabela ganha container com scroll próprio para o painel nunca rolar
 * horizontalmente.
 */
function Markdown({ children }: { children: string }) {
  return (
    <div className="[&>*+*]:mt-2 [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="leading-relaxed break-words">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-4">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-4">{children}</ol>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="bg-muted overflow-x-auto rounded-xl p-3 text-xs">
              {children}
            </pre>
          ),
          h1: ({ children }) => (
            <p className="font-display text-base font-semibold">{children}</p>
          ),
          h2: ({ children }) => (
            <p className="font-display text-base font-semibold">{children}</p>
          ),
          h3: ({ children }) => (
            <p className="font-display text-sm font-semibold">{children}</p>
          ),
          table: ({ children }) => (
            <div className="border-border/60 -mx-1 overflow-x-auto rounded-xl border">
              <table className="w-full text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="bg-muted/60 px-2.5 py-1.5 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-border/40 border-t px-2.5 py-1.5">
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * O desenho das bolhas, compartilhado por mensagem pronta, texto ao vivo e
 * indicadores.
 *
 * ⭐ UMA CONSTANTE, e não classes repetidas em cinco lugares: a bolha em escrita
 * e a bolha definitiva TÊM que ser idênticas, senão o texto "pula de lugar" no
 * instante em que o quadro `fim` chega e a segunda substitui a primeira.
 *
 * Cantos generosos (`rounded-[1.35rem]`) com UM canto fechado do lado de quem
 * fala — é o que dá a leitura de rabinho sem desenhar um triângulo.
 */
const BOLHA_BASE =
  "max-w-[85%] px-3.5 py-2.5 text-sm shadow-sm transition-shadow motion-reduce:transition-none";
const BOLHA_DO_BITZ =
  "bg-card/80 border-border/60 rounded-[1.35rem] rounded-tl-md border backdrop-blur text-foreground md:max-w-[80%]";
/** Entrada suave, de baixo para cima. Enfeite: `motion-reduce` desliga. */
const BOLHA_ENTRANDO =
  "animate-in fade-in-0 slide-in-from-bottom-1 duration-300 motion-reduce:animate-none";

export function BitzMessage({ message }: { message: BitzChatMessage }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className={cn("flex justify-end", BOLHA_ENTRANDO)}>
        <div
          className={cn(
            BOLHA_BASE,
            // Amarelo da marca, canto fechado à direita — do lado de quem fala.
            "bg-primary text-primary-foreground rounded-[1.35rem] rounded-tr-md",
            "leading-relaxed break-words whitespace-pre-wrap md:max-w-[75%]",
          )}
        >
          {/* O que foi anexado a ESTA pergunta. Só o rótulo: a leitura já foi
              conferida no cartão acima do campo e viajou junto — repeti-la aqui
              encheria a conversa de texto que o lojista acabou de ler.
              `whitespace-normal` porque a bolha inteira é `pre-wrap`, e sem
              isto o nome do arquivo herdaria a quebra literal. */}
          {message.anexos?.length ? (
            <span className="mb-1.5 flex flex-col gap-1 whitespace-normal">
              {message.anexos.map((a) => (
                <span
                  key={a.nome}
                  className="bg-primary-foreground/15 inline-flex items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-[11px]"
                >
                  {a.tipo === "xml-nfe" ? (
                    <FileText className="size-3 shrink-0" />
                  ) : (
                    <ImageIcon className="size-3 shrink-0" />
                  )}
                  <span className="max-w-[14rem] truncate">{a.nome}</span>
                </span>
              ))}
            </span>
          ) : null}
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex items-start gap-2.5", BOLHA_ENTRANDO)}>
      <BitzMascot size={28} state={message.errorCode ? "error" : "idle"} />
      <div
        className={cn(
          BOLHA_BASE,
          BOLHA_DO_BITZ,
          message.errorCode && "border-destructive/30",
        )}
      >
        <Markdown>{message.content}</Markdown>
        <BitzSources sources={message.sources} />
      </div>
    </div>
  );
}

/**
 * A resposta sendo escrita, ao vivo.
 *
 * Mesma bolha da mensagem pronta, de propósito: o texto não pode "pular de
 * lugar" quando o quadro final chega e a bolha definitiva o substitui.
 *
 * ⭐ SEM bloco de Fontes aqui. As fontes chegam no quadro `fim` — desenhar um
 * card vazio durante a escrita e preenchê-lo depois faria o card parecer parte
 * do texto que o modelo está redigindo, que é exatamente a confusão que a
 * separação servidor/modelo existe para evitar.
 */
export function BitzStreaming({
  content,
  consultando,
}: {
  content: string;
  consultando?: string[];
}) {
  if (!content) return <BitzThinking consultando={consultando} />;

  return (
    <div className="flex items-start gap-2.5" aria-live="polite">
      <BitzMascot size={28} state="thinking" aura />
      {/* ⚠️ EXATAMENTE a mesma bolha da mensagem pronta (as duas constantes,
          na mesma ordem). Qualquer divergência aqui faz o texto pular de lugar
          quando o quadro `fim` chega e a bolha definitiva o substitui. */}
      <div className={cn(BOLHA_BASE, BOLHA_DO_BITZ)}>
        <Markdown>{content}</Markdown>
      </div>
    </div>
  );
}

/** Como o painel chama cada consulta enquanto ela roda. */
const RÓTULO_DA_CONSULTA: Record<string, string> = {
  buscar_produto: "procurando a peça",
  detalhe_produto: "abrindo a ficha da peça",
  buscar_pedido: "procurando o pedido",
  contas_a_receber: "olhando as contas a receber",
  contas_a_pagar: "olhando as contas a pagar",
  buscar_orcamento: "procurando o orçamento",
  relatorio_vendas: "montando o relatório de vendas",
  relatorio_estoque: "olhando o estoque",
  buscar_sucata: "procurando a sucata",
  detalhe_sucata: "abrindo o lote",
  buscar_cliente: "procurando o cliente",
  buscar_localizacao: "procurando a localização",
  diagnostico_operacional: "verificando o que está com erro",
  sugerir_preco: "comparando preços",
  sugerir_medidas: "conferindo peso e medidas",
  sugerir_compatibilidades: "vendo em que carros serve",
  sugerir_categoria: "escolhendo a categoria",
  sugerir_titulo: "olhando seus títulos",
  sugerir_descricao: "olhando suas descrições",
  consultar_catalogo_ml: "consultando o catálogo do Mercado Livre",
};

/** Indicador de "pensando" — mascote com aura + três pontinhos. */
export function BitzThinking({ consultando }: { consultando?: string[] } = {}) {
  // Nome técnico de tool não é para o lojista ver. Sem rótulo conhecido, o
  // indicador continua sendo os três pontinhos de sempre.
  const rotulo = (consultando ?? [])
    .map((t) => RÓTULO_DA_CONSULTA[t])
    .filter(Boolean)[0];

  if (rotulo) {
    return (
      <div className="flex items-start gap-2.5" aria-live="polite">
        <BitzMascot size={28} state="thinking" aura />
        <div
          className={cn(
            BOLHA_DO_BITZ,
            "text-muted-foreground px-3.5 py-2.5 text-xs shadow-sm",
          )}
        >
          {rotulo}…
        </div>
      </div>
    );
  }

  return <BitzThinkingPontos />;
}

function BitzThinkingPontos() {
  return (
    <div className="flex items-start gap-2.5" aria-live="polite">
      <BitzMascot size={28} state="thinking" aura />
      <div
        className={cn(BOLHA_DO_BITZ, "flex items-center gap-1 px-3.5 py-3 shadow-sm")}
      >
        <span className="sr-only">Bitz está pensando</span>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden
            className="bg-muted-foreground size-1.5 rounded-full animate-[bitz-dot_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </div>
    </div>
  );
}
