/**
 * Numeração V2 — log estruturado com LISTA BRANCA de campos.
 *
 * Saída: `console[nivel]("[nfe-numeracao]", JSON.stringify({ evento, ...campos }))`.
 * Só os campos abaixo são impressos; todo o resto é descartado (token, senha
 * do certificado, CSC, CSRT, XML e dados do destinatário nunca chegam ao log).
 * Strings são truncadas em 200 caracteres; `chaveSufixo` imprime só os 10
 * últimos caracteres. Log nunca derruba a emissão: qualquer falha é engolida.
 *
 * Módulo sem imports; o único efeito é a escrita no console.
 */

export type NivelLogNumeracao = "info" | "warn" | "error";

export const PREFIXO_LOG_NUMERACAO = "[nfe-numeracao]";

export const CAMPOS_LOG_NUMERACAO: readonly string[] = [
  "userId",
  "nfeId",
  "cfcId",
  "ambiente",
  "modelo",
  "serie",
  "numero",
  "reservaId",
  "tentativa",
  "de",
  "para",
  "origem",
  "provedor",
  "cStat",
  "codigoProvedor",
  "chaveSufixo",
  "latenciaMs",
  "lockEsperaMs",
  "motivo",
  "classe",
  "estado",
];

const CAMPOS = new Set(CAMPOS_LOG_NUMERACAO);
const TAMANHO_MAX = 200;
const TAMANHO_SUFIXO_CHAVE = 10;

function truncar(s: string): string {
  return s.length > TAMANHO_MAX ? s.slice(0, TAMANHO_MAX) : s;
}

/** Só primitivos (e Date) passam; objeto/array/função são descartados. */
function valorSeguro(valor: unknown): string | number | boolean | null | undefined {
  if (valor === null) return null;
  switch (typeof valor) {
    case "string":
      return truncar(valor);
    case "number":
      return Number.isFinite(valor) ? valor : String(valor);
    case "boolean":
      return valor;
    case "bigint":
      return truncar(valor.toString());
    default:
      if (valor instanceof Date) {
        return Number.isFinite(valor.getTime()) ? valor.toISOString() : null;
      }
      return undefined;
  }
}

export function camposLogNumeracao(
  campos: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | null> {
  const saida: Record<string, string | number | boolean | null> = {};
  if (!campos || typeof campos !== "object") return saida;
  for (const nome of Object.keys(campos)) {
    if (!CAMPOS.has(nome)) continue;
    const bruto = campos[nome];
    if (nome === "chaveSufixo") {
      if (typeof bruto !== "string" && typeof bruto !== "number") continue;
      saida.chaveSufixo = String(bruto).slice(-TAMANHO_SUFIXO_CHAVE);
      continue;
    }
    const v = valorSeguro(bruto);
    if (v !== undefined) saida[nome] = v;
  }
  return saida;
}

export function logNumeracao(
  evento: string,
  campos: Record<string, unknown> = {},
  nivel: NivelLogNumeracao = "info",
): void {
  try {
    const metodo = nivel === "warn" || nivel === "error" ? nivel : "info";
    const linha = JSON.stringify({
      evento: truncar(String(evento)),
      ...camposLogNumeracao(campos),
    });
    console[metodo](PREFIXO_LOG_NUMERACAO, linha);
  } catch {
    // Log é best-effort: nunca interrompe a emissão.
  }
}
