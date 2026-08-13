// Constantes compartilhadas do widget do Bitz.
//
// A flag é lida como CONST de módulo (e não por função, como no backend):
// no front o Next INLINA `process.env.NEXT_PUBLIC_*` no build, então esta
// comparação vira um booleano literal.
//
// ⚠️ Isso sozinho NÃO tira o widget do bundle. Medido: um
// `if (!FLAG) return null` dentro do componente deixa o shell 2,9 KB gz maior
// com a flag ligada E desligada, porque o early-return é runtime e os imports
// do topo do módulo entram no bundle do mesmo jeito. Quem cumpre a promessa de
// "flag desligada ⇒ nenhum byte a mais" é a fronteira de `dynamic()` em
// `bitz-root.tsx` — esta const só decide se aquele chunk chega a ser buscado.
//
// Consequência operacional: ligar/desligar exige REBUILD do front, não só
// restart. Está documentado no .env.example.
export const AI_MODULE_ENABLED =
  process.env.NEXT_PUBLIC_AI_MODULE_ENABLED === "true";

/** Fontes do mascote. WebP com PNG de fallback, servidos de /public/bitz. */
export const MASCOT = {
  webp128: "/bitz/bitz-mascote-128.webp",
  webp256: "/bitz/bitz-mascote-256.webp",
  webp512: "/bitz/bitz-mascote-512.webp",
  png128: "/bitz/bitz-mascote-128.png",
  png256: "/bitz/bitz-mascote-256.png",
  /**
   * O LOOP — 190×294, 29 quadros, 2,4 s, loop infinito, **235 KB**.
   *
   * É o robô se mexendo sem começo nem fim, usado na tela "Conheça o Bitz".
   * Loop infinito é obrigatório aqui: o painel fica montado para sempre, e um
   * WebP de loop finito congelaria no último quadro.
   *
   * ⚠️ Só é buscado quando `BitzMascotAnimado` monta — dentro do chunk dinâmico
   * do painel, ou seja, depois do primeiro clique. Nunca entra no shell.
   */
  loop: "/bitz/bitz-mascote-loop.webp",
  /**
   * A ENTRADA — 260×354, 144 quadros, 9,6 s, loop 1, **1.045 KB**.
   *
   * O material original menos a emenda do loop: o robô sai do canto da tela, se
   * apresenta e vai embora. Um megabyte é muito para um enfeite — e é por isso
   * que ele toca UMA VEZ NA VIDA de cada usuário (ver `bitz-onboarding.ts`) e só
   * é baixado nessa única ocasião. Quem já viu nunca mais pede o arquivo.
   *
   * ⚠️ Os 6 quadros finais do material (9,60 s → 10,0 s) são a VOLTA AO COMEÇO,
   * que o autor deixou lá para o vídeo poder rodar em loop. Aqui a animação toca
   * uma vez só: aquilo virava um solavanco de meio segundo no fim, o robô sumia
   * e reaparecia do início. Foram cortados na reexportação.
   *
   * Loop 1 é o correto aqui, ao contrário do arquivo acima: esta animação tem
   * um fim narrativo, e o componente que a exibe morre junto com ela.
   */
  entrada: "/bitz/bitz-mascote-entrada.webp",
} as const;

/** Teto de caracteres da mensagem — espelha MAX_USER_MESSAGE_CHARS do backend. */
export const MAX_MESSAGE_CHARS = 4000;

export type BitzPanelMode = "docked" | "fullscreen";

/**
 * A frase que o botão "Corrigir" deixa começada no campo de escrita (P3.1).
 *
 * ⭐ "REFAZ", E NÃO "CORRIGE". O que vem a seguir é uma proposta NOVA — a antiga
 * já foi cancelada pelo cartão. "Refaz" é o que faz o modelo reaproveitar da
 * conversa os campos que estavam certos e trocar só o que o lojista disser; é
 * exatamente isso que poupa reditar marca, modelo, ano e placa por causa da cor.
 *
 * ⚠️ TERMINA COM ESPAÇO, de propósito: o cursor para logo depois dele e o
 * lojista continua a frase sem ter de abrir espaço na mão. Comer esse espaço
 * produziria "…, masa cor é prata".
 *
 * Pura e exportada para poder ser testada de verdade — a suíte roda em
 * `environment: "node"` e não renderiza React, então a alternativa seria só ler
 * o fonte e conferir que a linha existe, o que não prova o que ela escreve.
 */
export function fraseDeCorrecao(titulo: string): string {
  return `Refaz "${String(titulo ?? "").trim().toLowerCase()}", mas `;
}
