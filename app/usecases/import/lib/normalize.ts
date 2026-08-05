/**
 * Helpers PUROS de normalização de dados legados, extraídos dos scripts de
 * migração validados em produção (scripts/migracao-vaapt.ts,
 * scripts/migracao-vaapt-nfes.ts, scripts/migracao-webdesmonte.ts). Mantidos
 * byte-a-byte na semântica para preservar a idempotência com tenants que já
 * foram migrados manualmente pelos scripts.
 */

export function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Decimais BR: "1.234,56" → 1234.56 (com vírgula, o ponto é milhar). */
export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (s === "") return null;
  const cleaned = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function asInt(value: unknown): number | null {
  const n = asNumber(value);
  if (n === null) return null;
  return Math.trunc(n);
}

export function onlyDigits(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\D/g, "");
}

function isAllSameDigit(s: string): boolean {
  return s.length > 0 && /^(\d)\1*$/.test(s);
}

/**
 * Recupera zero à esquerda cortado pelo Excel (número → string) e valida o
 * comprimento. Rejeita placeholders (todos os dígitos iguais: 000…, 999…).
 */
export function padDoc(raw: unknown, len: number): string | null {
  let d = onlyDigits(raw);
  if (d.length === 0) return null;
  if (d.length < len && len - d.length <= 2) d = d.padStart(len, "0");
  if (d.length !== len) return null;
  if (isAllSameDigit(d)) return null;
  return d;
}

export const validCPF = (raw: unknown): string | null => padDoc(raw, 11);
export const validCNPJ = (raw: unknown): string | null => padDoc(raw, 14);

export function toCep(raw: unknown): string | null {
  let d = onlyDigits(raw);
  if (d.length === 0) return null;
  if (d.length < 8 && 8 - d.length <= 2) d = d.padStart(8, "0");
  return d.length === 8 ? d : null;
}

const UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
  "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
  "SP", "SE", "TO",
]);

export function toUf(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const u = s.trim().toUpperCase();
  return UFS.has(u) ? u : null;
}

export function toEmail(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Trata o literal "undefined" (comum nas bases Vaapt) como vazio. */
export function cleanUndefined(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  return s.toLowerCase() === "undefined" ? null : s;
}

export function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isPlaceholderName(name: string): boolean {
  const n = normName(name);
  return (
    n.length === 0 ||
    n.includes("NAO IDENTIFICADO") ||
    n === "UNDEFINED UNDEFINED" ||
    n === "UNDEFINED"
  );
}

/**
 * Chassi: só alfanumérico, ≥11 chars, rejeita caractere repetido. NÃO impõe
 * os 17 exatos aqui — quem impõe é o ScrapUseCase; o mapeador usa esta
 * limpeza e, se o resultado não tiver 17, grava SEM chassi e reporta aviso
 * (linha nunca é derrubada por chassi sujo).
 */
export function cleanChassis(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]+$/.test(up)) return null;
  if (up.length < 11) return null;
  if (/^(.)\1*$/.test(up)) return null;
  return up;
}

export function cleanPlate(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (up.length < 6 || up.length > 8) return null;
  return up;
}

/** Datas mistas: "2024-05-31", "dd/mm/yyyy" ou serial Excel (46206). */
export function parseFlexibleDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Chave normalizada de rótulo de coluna: remove acentos, parênteses e tudo
 * que não é [a-z0-9]. É o que torna a detecção/leitura tolerante a variações
 * de caixa/acento entre exports ("N° NFe" → "nnfe").
 */
export function normKey(s: string): string {
  return s
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * `normKey` memoizado, para os getters que rodam POR LINHA.
 *
 * `normKey` custa ~287ns (regex + `normalize("NFD")` + duas substituições).
 * Barato isolado, caro no laço: o mapper de fotos lê 2 rótulos por linha e cada
 * leitura normaliza o rótulo DUAS vezes — uma no `aliasReader`, para saber se a
 * coluna existe, outra dentro do `get` do reader, para achar a chave. São 4
 * chamadas por linha; nas 653.239 linhas do export do Emp595, **2.612.956
 * chamadas** e ~750ms para recalcular sempre os mesmos 2 rótulos.
 *
 * ⚠️ O memo é DA INSTÂNCIA, nunca global. Cada `readXlsxBuffer`/`readCsvBuffer`/
 * `aliasReader` cria o seu, e ele morre junto com o arquivo. As chaves são
 * RÓTULOS DE COLUNA — literais escritos nos mappers, um punhado por arquivo —,
 * nunca valores de célula; um memo global cresceria sem teto se alguém um dia
 * chamasse `normKey` sobre dado. Como `normKey` é pura, o resultado é
 * idêntico ao de recalcular.
 */
export function createNormKeyMemo(
  // Injetável só para o teste conseguir CONTAR as chamadas — o efeito do memo
  // é invisível na saída (`normKey` é pura), então sem esta costura não há como
  // provar que ele memoiza de verdade. Produção sempre usa o default.
  normalizar: (s: string) => string = normKey,
): (s: string) => string {
  const memo = new Map<string, string>();
  return (s) => {
    let k = memo.get(s);
    // ⚠️ `=== undefined`, nunca `!k`: um rótulo só de pontuação (`"###"`, ou
    // `"(obs)"`, cujo conteúdo entre parênteses é removido) normaliza para
    // `""`, que é falsy. Com `!k` ele recalcularia a cada linha — o memo
    // pareceria funcionar, porque a saída é idêntica, e não economizaria nada.
    if (k === undefined) {
      k = normalizar(s);
      memo.set(s, k);
    }
    return k;
  };
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
