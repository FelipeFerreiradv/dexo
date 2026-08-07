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
} as const;

/** Teto de caracteres da mensagem — espelha MAX_USER_MESSAGE_CHARS do backend. */
export const MAX_MESSAGE_CHARS = 4000;

export type BitzPanelMode = "docked" | "fullscreen";
