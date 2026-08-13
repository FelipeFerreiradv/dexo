"use client";

import { cn } from "@/lib/utils";

/**
 * As ESCOLHAS CLICÁVEIS de uma desambiguação.
 *
 * ⭐ O problema que isto resolve: o pátio tem três Gol, o lojista digitou "Gol",
 * e até aqui o Bitz listava os três em prosa e esperava que ele reescrevesse a
 * placa. É o ponto exato em que o chat perde para a tela — ler três linhas e
 * redigitar uma é mais trabalho que clicar numa lista.
 *
 * ⚠️ SÓ A ÚLTIMA MENSAGEM MOSTRA OS BOTÕES (quem decide é `bitz-message`).
 * Opção de uma pergunta antiga é armadilha: o lojista rola a conversa, clica no
 * que parecia certo três turnos atrás e manda uma frase que não tem mais
 * contexto nenhum. Foi a mesma classe de defeito do cartão que ressuscitava ao
 * reabrir o painel.
 */

export interface BitzOpcao {
  rotulo: string;
  enviar: string;
}

/** Parsing defensivo do que veio pela rede. Mesmo padrão de `lerAcoes`. */
export function lerOpcoes(bruto: unknown): BitzOpcao[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter(
    (o: any): o is BitzOpcao =>
      !!o &&
      typeof o.rotulo === "string" &&
      o.rotulo.length > 0 &&
      typeof o.enviar === "string" &&
      o.enviar.length > 0,
  );
}

interface Props {
  opcoes: BitzOpcao[];
  /** Manda a frase da opção como se o lojista a tivesse digitado. */
  aoEscolher: (texto: string) => void;
  /** Enquanto o turno anterior não terminou, clicar atropelaria a resposta. */
  desabilitado?: boolean;
}

export function BitzOpcoes({ opcoes, aoEscolher, desabilitado }: Props) {
  if (!opcoes.length) return null;

  return (
    <div
      className="mt-2.5 flex flex-wrap gap-1.5"
      role="group"
      aria-label="Escolha uma opção"
    >
      {opcoes.map((o, i) => (
        <button
          key={`${o.enviar}-${i}`}
          type="button"
          disabled={desabilitado}
          onClick={() => aoEscolher(o.enviar)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-left text-xs font-medium transition-colors",
            "border-border bg-background text-foreground",
            "hover:bg-accent hover:text-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}
