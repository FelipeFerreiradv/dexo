/**
 * Fronteira de normalização do cStat vindo dos provedores fiscais.
 *
 * Por que existe: o Focus NFe devolve `status_sefaz` como STRING ("974") e, no
 * HTTP 422, `codigo` como string NÃO numérica ("erro_validacao_schema"). O SEFAZ
 * direto já devolve número (extractIntValue). A coluna `NfeEmitida.cStatRejeicao`
 * é `Int?` — gravar a string derrubava a emissão com PrismaClientValidationError
 * DEPOIS de a nota já estar REJECTED, perdendo motivo e cStat (produção,
 * 16/09/2026, nota cmu4gzo2q0q4e18xpsr1zgzgr).
 *
 * Regra: só vira inteiro o que é inequivocamente um código numérico de 1 a 4
 * dígitos (com espaços em volta tolerados). Qualquer outra coisa vira `null` —
 * o valor bruto deve ser preservado pelo chamador na auditoria, nunca inventado.
 *
 * Módulo PURO (sem imports) — seguro para backend, testes e client.
 */

const CSTAT_TEXTO = /^\s*(\d{1,4})\s*$/;

export function normalizarCStat(valor: unknown): number | null {
  if (typeof valor === "number") {
    return Number.isInteger(valor) && valor >= 0 && valor <= 9999 ? valor : null;
  }
  if (typeof valor === "string") {
    const m = CSTAT_TEXTO.exec(valor);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/**
 * Código bruto do provedor quando ele NÃO é um cStat numérico (ex.: Focus
 * "erro_validacao_schema"), para registrar na auditoria sem perder informação.
 * Devolve `null` quando o valor já é representado por `normalizarCStat`.
 * Limitado a 64 caracteres (o conteúdo vem de resposta externa).
 */
export function codigoProvedorNaoNumerico(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (normalizarCStat(valor) !== null) return null;
  const texto = String(valor).trim();
  return texto ? texto.slice(0, 64) : null;
}
