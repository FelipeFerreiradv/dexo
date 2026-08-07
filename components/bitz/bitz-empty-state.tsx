"use client";

import * as React from "react";
import { ArrowRight, BarChart3, Search, Sparkles, Tag } from "lucide-react";

import { cn } from "@/lib/utils";
import { BitzMascotVideo } from "./bitz-mascot-video";

interface AcaoCard {
  icon: React.ElementType;
  titulo: string;
  descricao: string;
  prompt: string;
}

const ACOES: AcaoCard[] = [
  {
    icon: Sparkles,
    titulo: "Tirar dúvida",
    descricao: "Como fazer alguma coisa no Dexo",
    prompt: "Como eu emito etiquetas no Dexo?",
  },
  {
    icon: BarChart3,
    titulo: "Relatório",
    descricao: "Vendas, estoque, financeiro",
    prompt: "Quanto eu vendi no mês passado?",
  },
  {
    icon: Tag,
    titulo: "Sugerir preço",
    descricao: "Com base na base da plataforma",
    prompt: "Qual o melhor preço para um cubo de roda dianteiro de Palio?",
  },
  {
    icon: Search,
    titulo: "Consultar",
    descricao: "Peça, cliente, pedido, sucata",
    prompt: "Me mostra as peças com estoque baixo.",
  },
];

const TEMAS = [
  {
    id: "vendas",
    label: "Vendas",
    perguntas: [
      "Quanto eu vendi em julho?",
      "Qual marketplace mais fatura pra mim?",
      "Quais peças mais saíram nos últimos 30 dias?",
    ],
  },
  {
    id: "estoque",
    label: "Estoque",
    perguntas: [
      "Quais peças estão com estoque baixo?",
      "Quantos produtos eu tenho cadastrados?",
      "Como funciona o Scan de recebimento?",
    ],
  },
  {
    id: "anuncios",
    label: "Anúncios",
    perguntas: [
      "Como eu publico um anúncio no Mercado Livre?",
      "Por que meu anúncio está pausado?",
      "Qual categoria usar para uma lanterna traseira?",
    ],
  },
  {
    id: "financeiro",
    label: "Financeiro",
    perguntas: [
      "Quanto eu tenho a receber?",
      "Quanto está vencido?",
      "Como funciona a venda no balcão?",
    ],
  },
  {
    id: "sucatas",
    label: "Sucatas",
    perguntas: [
      "Quantas peças saíram da última sucata?",
      "Como eu cadastro uma sucata nova?",
      "Quanto já recuperei de uma sucata?",
    ],
  },
] as const;

function saudacao(hora: number): string {
  if (hora < 12) return "Bom dia";
  if (hora < 18) return "Boa tarde";
  return "Boa noite";
}

interface BitzEmptyStateProps {
  nome?: string | null;
  onPergunta: (texto: string) => void;
  className?: string;
}

/**
 * Tela inicial do painel — a "tela 1" da referência de design, traduzida para
 * a identidade do Dexo: cards de ação em grade 2×2, chips de tema e sugestões
 * clicáveis. As sugestões são a única forma de o usuário descobrir o que o
 * Bitz sabe fazer sem ter que adivinhar.
 */
export function BitzEmptyState({
  nome,
  onPergunta,
  className,
}: BitzEmptyStateProps) {
  const [tema, setTema] = React.useState<string>(TEMAS[0].id);

  // Calculado no cliente após a montagem: usar `new Date()` no render inicial
  // dispararia hydration mismatch entre servidor e navegador.
  const [hora, setHora] = React.useState<number | null>(null);
  React.useEffect(() => setHora(new Date().getHours()), []);

  const perguntas =
    TEMAS.find((t) => t.id === tema)?.perguntas ?? TEMAS[0].perguntas;

  const primeiroNome = nome?.trim().split(/\s+/)[0];

  return (
    <div className={cn("flex flex-col gap-6 p-4 sm:p-6", className)}>
      <div className="flex items-start gap-3">
        {/* A saudação é o momento da animação: toca uma vez ao abrir o
            painel, sem segurar nada. Cai no mascote estático se o vídeo não
            puder tocar. */}
        <BitzMascotVideo size={52} />
        <div className="min-w-0 pt-1">
          <p className="text-muted-foreground text-sm">
            {hora === null ? "Olá" : saudacao(hora)}
            {primeiroNome ? `, ${primeiroNome}` : ""}
          </p>
          <h2 className="font-display text-foreground text-xl leading-tight font-semibold sm:text-2xl">
            Como posso ajudar?
          </h2>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {ACOES.map((acao) => (
          <button
            key={acao.titulo}
            type="button"
            onClick={() => onPergunta(acao.prompt)}
            className={cn(
              "group bg-card/70 border-border/60 rounded-2xl border p-3.5 text-left backdrop-blur",
              "hover:border-primary/50 hover:bg-card focus-visible:ring-ring transition",
              "focus-visible:ring-2 focus-visible:outline-none",
              "motion-reduce:transition-none",
            )}
          >
            <span className="bg-primary/15 text-foreground mb-2.5 inline-flex size-8 items-center justify-center rounded-xl">
              <acao.icon className="size-4" />
            </span>
            <span className="text-foreground flex items-center gap-1 text-sm font-medium">
              {acao.titulo}
              <ArrowRight className="text-muted-foreground size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </span>
            <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
              {acao.descricao}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Sugestões
        </p>

        <div
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
          role="tablist"
          aria-label="Temas de sugestão"
        >
          {TEMAS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tema === t.id}
              onClick={() => setTema(t.id)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition",
                "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                "motion-reduce:transition-none",
                tema === t.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          {perguntas.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPergunta(p)}
              className={cn(
                "bg-card/70 border-border/60 rounded-2xl border px-3.5 py-3 text-left text-sm backdrop-blur",
                "text-foreground hover:border-primary/50 hover:bg-card transition",
                "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                "motion-reduce:transition-none",
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
