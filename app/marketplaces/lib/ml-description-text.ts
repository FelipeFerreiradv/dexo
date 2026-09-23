/**
 * Texto da descrição que o Mercado Livre aceita em `plain_text`.
 *
 * O ML recusa emoji na descrição ("The description must be in plain text",
 * cause 398 `item.description.type.invalid` — doc "Descrição de produtos"). Na
 * prática o anúncio era criado com a descrição VAZIA e a Dexo registrava
 * sucesso: medido em 23/09/2026, 12 de 12 anúncios cuja descrição tinha "⚠️"
 * ou "🚗" estavam sem descrição no ML (inclusive de 18/09), ~300 anúncios
 * ativos no total. Caso reportado: SKU 7167 de um cliente, com o bloco
 * "⚠️ ATENÇÃO E OBSERVAÇÕES IMPORTANTES" na descrição padrão.
 *
 * Dois níveis, para não mexer no que já funciona:
 * - "basico": tira o emoji fora do plano básico (🚗, 😀…) e os caracteres que
 *   montam emoji (seletor de variação U+FE0F do "⚠️", junção U+200D, tecla
 *   U+20E3). As letras "em negrito" copiadas de rede social (𝗣𝗘𝗖̧𝗔, 𝟵𝟬 —
 *   também fora do plano básico) viram as letras comuns em vez de sumir.
 *   Descrição sem nada disso volta idêntica.
 * - "estrito": além disso, os símbolos do plano básico a partir de U+2190
 *   (⚠ ✅ ✔ ❌ ★ ✓ ● ► → ≥ ☎…). Usado só quando o ML recusa ou grava vazio.
 *   ©, ®, ™, °, ½ e a pontuação comum ficam (estão abaixo de U+2190).
 *
 * O espaço só é arrumado onde algo saiu ("⚠️ ATENÇÃO" → "ATENÇÃO",
 * "Peça🚗Original" → "Peça Original"); a formatação do resto não muda.
 */

export type DescriptionSanitizeMode = "basico" | "estrito";

const PICTOGRAFICO = /\p{Extended_Pictographic}/u;
const SIMBOLO = /\p{S}/u;
const LETRA_OU_NUMERO = /[\p{L}\p{N}]/u;

function descartar(cp: number, ch: string, mode: DescriptionSanitizeMode): boolean {
  if (cp > 0xffff) return true; // emoji e demais fora do plano básico
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // seletores de variação
  if (cp === 0x200d || cp === 0x20e3) return true; // junção / tecla
  return (
    mode === "estrito" && cp >= 0x2190 && (PICTOGRAFICO.test(ch) || SIMBOLO.test(ch))
  );
}

/** Letra/dígito "em negrito/itálico" (U+1D400–U+1D7FF) → a letra comum. */
function transliterar(cp: number, ch: string): string | null {
  if (cp < 0x1d400 || cp > 0x1d7ff) return null;
  const comum = ch.normalize("NFKC");
  if (comum === ch) return null; // posição sem letra atribuída
  for (const c of comum) if ((c.codePointAt(0) ?? 0) > 0xffff) return null;
  return comum;
}

const ehEspaco = (ch: string) => ch === " " || ch === "\t";
const ehQuebra = (ch: string) => ch === "\n" || ch === "\r";

/**
 * `removed` conta os caracteres tirados ou trocados; 0 ⇒ `text` é a própria
 * string recebida.
 */
export function sanitizeMLDescription(
  text: string | null | undefined,
  mode: DescriptionSanitizeMode = "basico",
): { text: string; removed: number } {
  const original = text ?? "";
  let removed = 0;
  let trocou = false;
  let out = "";
  let lacuna = false; // um ou mais caracteres acabaram de sair
  for (const ch of original) {
    const cp = ch.codePointAt(0) ?? 0;
    const comum = transliterar(cp, ch);
    if (comum === null && descartar(cp, ch, mode)) {
      removed += 1;
      lacuna = true;
      continue;
    }
    if (lacuna) {
      const anterior = out.slice(-1);
      const inicioDeLinha = anterior === "" || ehQuebra(anterior);
      if (ehEspaco(ch)) {
        // espaço que o símbolo deixou: no início da linha ou repetido
        if (inicioDeLinha || ehEspaco(anterior)) continue;
      } else if (ehQuebra(ch)) {
        out = out.replace(/[ \t]+$/, ""); // "fim 🚗\n" → "fim\n"
      } else if (LETRA_OU_NUMERO.test(anterior) && LETRA_OU_NUMERO.test(comum ?? ch)) {
        out += " "; // "Peça🚗Original" → "Peça Original"
      }
      lacuna = false;
    }
    if (comum !== null) {
      removed += 1;
      trocou = true;
      out += comum;
    } else {
      out += ch;
    }
  }
  if (removed === 0) return { text: original, removed: 0 };
  if (lacuna) out = out.replace(/[ \t]+$/, "");
  // "𝗖̧" → "C" + cedilha solta: recompõe em "Ç".
  if (trocou) out = out.normalize("NFC");
  return { text: out, removed };
}

/**
 * Sobrou símbolo que o nível estrito tiraria? Só então vale conferir o que o
 * ML gravou (e só então regravar ajuda) — descrição comum não ganha chamada a
 * mais.
 */
export function descriptionHasSymbols(text: string | null | undefined): boolean {
  for (const ch of text ?? "") {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2190 && descartar(cp, ch, "estrito")) return true;
  }
  return false;
}

/** Erro do ML para caractere não aceito na descrição (cause 398). */
export function isInvalidDescriptionCharError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    msg.includes("item.description.type.invalid") ||
    msg.includes("must be in plain text")
  );
}

/**
 * O ML não guardou a descrição: gravou VAZIA mesmo sem os símbolos
 * (`empty_after_write`) ou recusou um caractere que o nível estrito não tira
 * (`rejected`). Quem edita um anúncio trata como aviso — o resto da edição já
 * foi aplicado no ML.
 */
export class MLDescriptionNotSavedError extends Error {
  constructor(
    readonly itemId: string,
    readonly reason: "empty_after_write" | "rejected",
    detail?: string,
  ) {
    super(
      reason === "empty_after_write"
        ? `Erro ao atualizar descrição: o Mercado Livre gravou a descrição de ${itemId} VAZIA (caractere não aceito no texto).`
        : `Erro ao atualizar descrição: o Mercado Livre recusou um caractere da descrição de ${itemId}.${detail ? ` ${detail}` : ""}`,
    );
    this.name = "MLDescriptionNotSavedError";
  }
}
