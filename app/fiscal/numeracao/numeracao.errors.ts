/** Erro de domínio transportável pelas rotas fiscais, sem detalhes do banco. */
export class NumeracaoError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    mensagem: string,
    readonly detalhes?: Record<string, unknown>,
  ) {
    super(mensagem);
    this.name = "NumeracaoError";
  }
}

export function concorrencia(): never {
  throw new NumeracaoError("NUMERACAO_CONCORRENCIA", 409, "Numeração alterada em paralelo — tente novamente");
}

/** O descarte do nº retido só vale para reserva viva em BLOQUEADO (os demais estados têm saída própria). */
export function naoBloqueada(): never {
  throw new NumeracaoError("NUMERACAO_NAO_BLOQUEADA", 409, "O número desta NF-e não está retido para conferência — não há o que descartar");
}

export function tabelaFiscalAusente(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; meta?: { code?: unknown } };
  return e.code === "P2021" || e.code === "42P01" || (e.code === "P2010" && e.meta?.code === "42P01");
}
