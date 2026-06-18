/**
 * Predicados PUROS da limpeza de legados Vaapt → IBR (tenant IBR).
 *
 * Sem acesso a DB, sem efeitos colaterais — 100% testável por unidade.
 * Estas funções são a ÚNICA fonte de verdade da classificação; o script
 * orquestrador (`scripts/cleanup-legacy-vaapt-ibr.ts`) só as aplica.
 *
 * REGRAS FINAIS (confirmadas pelo cliente na Fase 0):
 *  EXCLUIR (dentro do escopo e sem histórico protegido):
 *    - convertido (centena): ^(100|200|300|400|500|800)\d{3,4}$   (len 6-7)
 *    - cru Vaapt:            ^[HJY]-?\d+$                          (J-4997, Y-5881, H-802)
 *  PRESERVAR (nunca excluir):
 *    - QUALQUER numérico puro SEM prefixo de centena reconhecido (inclui <18000 e >=18000)
 *  REVISAR (não excluir; listar p/ decisão):
 *    - ML-MLB…, letras (V/G/C/O…), dash \d+-\d+ (50021-57), numérico 6-7 fora do set (359444), lixo
 *  PROTEGIDO_HISTORICO: tem OrderItem/NfeItem/ReceivableItem (mesmo casando exclusão).
 *
 * Invariante de segurança: um SKU numérico puro sem prefixo de centena NUNCA
 * é "excluível" — logo nunca entra em `a_excluir`.
 */
import { normalizeText } from "@/app/localizacoes/lib/search-utils";

/** Prefixos de centena que representam letras Vaapt convertidas (de/para fechado). */
export const CENTENA_PREFIXES = [100, 200, 300, 400, 500, 800] as const;

/** De/para documental conhecido (400/500/800 = outras letras Vaapt não nomeadas). */
export const DE_PARA_VAAPT_IBR = { H: 100, J: 200, Y: 300 } as const;
export type VaaptLetter = keyof typeof DE_PARA_VAAPT_IBR;

/** Convertido: centena (3 díg do set) + sufixo de 3-4 díg → comprimento total 6-7. */
export const RE_CONVERTED = /^(100|200|300|400|500|800)\d{3,4}$/;
/** Cru Vaapt: letra H/J/Y + número (hífen opcional). */
export const RE_RAW_HJY = /^[HJY]-?\d+$/i;
/** Caixa numérica simples (após normalizeText): "caixa 437" | "caixa276" | "caixa-155". */
export const RE_CAIXA = /^caixa[\s-]*(\d{1,4})$/;

export type Bucket =
  | "a_excluir"
  | "preservado"
  | "protegido_historico"
  | "revisar"
  | "fora_de_escopo";

export type ExclusionRule = "convertido" | "cru_hjy";

export interface BucketCtx {
  /** O Location.code do produto casa caixa numérica simples? */
  inScope: boolean;
  hasOrderItem: boolean;
  hasNfeItem: boolean;
  hasReceivableItem: boolean;
}

export interface BucketResult {
  bucket: Bucket;
  rule?: ExclusionRule;
  /** prefixo de centena (convertido), letra (cru), ou motivo (revisar). */
  detail?: string;
}

/** Número da caixa, ou null se não é caixa numérica simples (ou é "madeira"). */
export function caixaNumero(code: string | null | undefined): number | null {
  const n = normalizeText(code);
  if (!n || n.includes("madeira")) return null;
  const m = RE_CAIXA.exec(n);
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isInteger(num) && num >= 1 ? num : null;
}

export function isCaixaNumericaSimples(code: string | null | undefined): boolean {
  return caixaNumero(code) != null;
}

/** Convertido → prefixo de centena (∈ CENTENA_PREFIXES), ou null. */
export function matchConverted(sku: string | null | undefined): { prefix: number } | null {
  const s = (sku ?? "").trim();
  const m = RE_CONVERTED.exec(s);
  return m ? { prefix: Number(m[1]) } : null;
}

/** Cru Vaapt → letra {H,J,Y}, ou null. */
export function matchRawVaapt(sku: string | null | undefined): { letter: VaaptLetter } | null {
  const s = (sku ?? "").trim();
  if (!RE_RAW_HJY.test(s)) return null;
  return { letter: s[0].toUpperCase() as VaaptLetter };
}

/**
 * Excluível por padrão de SKU (convertido OU cru). NÃO usa valor numérico:
 * numéricos puros (sem prefixo de centena) jamais são excluíveis.
 */
export function isExcluivel(sku: string | null | undefined): boolean {
  return matchConverted(sku) != null || matchRawVaapt(sku) != null;
}

/** Motivo de "revisar" para um SKU NÃO-excluível (ou null se é preservado numérico). */
function motivoRevisar(sku: string): string | null {
  const s = sku.trim();
  if (s === "") return "lixo";
  if (/^ML-/i.test(s)) return "ml";
  if (/^[A-Za-z]/.test(s)) return "letra"; // V/G/C/O… (H/J/Y já tratados antes)
  if (/^\d+$/.test(s)) {
    if (!Number.isSafeInteger(Number(s))) return "lixo"; // número gigante corrompido
    if (s.length === 6 || s.length === 7) return "num_6_7"; // 6-7 díg fora do set (ex. 359444) — possível convertido disfarçado, revisar
    return null; // demais numéricos puros → preservado (inclui <18000, >=18000 e 8+ díg)
  }
  if (/^\d+-\d+$/.test(s)) return "dash"; // 50021-57
  return "lixo";
}

/**
 * Classificação final de um produto. Precedência:
 *   fora_de_escopo → (excluível ? protegido_historico : a_excluir) → revisar → preservado
 */
export function bucketOf(sku: string | null | undefined, ctx: BucketCtx): BucketResult {
  const s = (sku ?? "").trim();

  if (!ctx.inScope) return { bucket: "fora_de_escopo" };

  const conv = matchConverted(s);
  if (conv) {
    if (ctx.hasOrderItem || ctx.hasNfeItem || ctx.hasReceivableItem)
      return { bucket: "protegido_historico", rule: "convertido", detail: String(conv.prefix) };
    return { bucket: "a_excluir", rule: "convertido", detail: String(conv.prefix) };
  }
  const raw = matchRawVaapt(s);
  if (raw) {
    if (ctx.hasOrderItem || ctx.hasNfeItem || ctx.hasReceivableItem)
      return { bucket: "protegido_historico", rule: "cru_hjy", detail: raw.letter };
    return { bucket: "a_excluir", rule: "cru_hjy", detail: raw.letter };
  }

  const motivo = motivoRevisar(s);
  if (motivo) return { bucket: "revisar", detail: motivo };
  return { bucket: "preservado" };
}
