/**
 * Mapeamento dos códigos cStat retornados pela SEFAZ.
 *
 * Tabela viva — vai sendo expandida fase por fase conforme adicionamos
 * operações. Fonte: Manual de Orientação NFe + Anexo III (Códigos e Motivos).
 *
 * Convenção:
 *  - Status final que muda estado da NFe no nosso domínio → categoria semântica.
 *  - Status de "infra/transient" → "infra".
 *  - Default desconhecido → "desconhecido".
 */

export type CStatCategoria =
  | "servico_operacional"
  | "servico_indisponivel"
  | "autorizada"
  | "denegada"
  | "rejeitada"
  | "lote_recebido"
  | "lote_processado"
  | "lote_em_processamento"
  | "cancelada"
  | "inutilizada"
  | "evento_registrado"
  | "duplicidade"
  | "nao_consta"
  | "infra"
  | "desconhecido";

interface CStatInfo {
  categoria: CStatCategoria;
  descricao: string;
  /** Se aplicável, motivo padrão da SEFAZ (xMotivo conhecido). */
  motivoPadrao?: string;
}

const TABLE: Record<number, CStatInfo> = {
  // ── Status do Serviço (NfeStatusServico4) ──
  107: {
    categoria: "servico_operacional",
    descricao: "Serviço em Operação",
    motivoPadrao: "Servico em Operacao",
  },
  108: {
    categoria: "servico_indisponivel",
    descricao: "Serviço Paralisado Momentaneamente",
    motivoPadrao: "Servico Paralisado Momentaneamente (curto prazo)",
  },
  109: {
    categoria: "servico_indisponivel",
    descricao: "Serviço Paralisado sem Previsão",
  },

  // Códigos abaixo entram em uso pleno na Fase F-D, mas registramos a
  // categoria desde já para o mapper ser usado consistentemente.
  100: { categoria: "autorizada", descricao: "Autorizado o uso da NF-e" },
  101: { categoria: "cancelada", descricao: "Cancelamento de NF-e homologado" },
  102: { categoria: "inutilizada", descricao: "Inutilização homologada" },
  103: { categoria: "lote_recebido", descricao: "Lote recebido com sucesso" },
  104: { categoria: "lote_processado", descricao: "Lote processado" },
  105: {
    categoria: "lote_em_processamento",
    descricao: "Lote em processamento",
  },
  110: { categoria: "denegada", descricao: "Uso denegado" },
  135: { categoria: "evento_registrado", descricao: "Evento registrado" },
  150: {
    categoria: "autorizada",
    descricao: "Autorizado o uso da NF-e fora de prazo",
  },
  217: { categoria: "nao_consta", descricao: "NF-e nao consta na base" },
  218: {
    categoria: "duplicidade",
    descricao: "NF-e ja foi autorizada (duplicidade)",
  },
  204: {
    categoria: "duplicidade",
    descricao: "Duplicidade de NFe (NFe ja autorizada)",
  },
  539: {
    categoria: "duplicidade",
    descricao: "Duplicidade de NFe com diferenca na chave de acesso",
  },
  573: {
    categoria: "duplicidade",
    descricao: "Duplicidade de evento (ja registrado para a chave)",
  },
  136: {
    categoria: "evento_registrado",
    descricao: "Evento registrado, mas nao vinculado a NF-e",
  },
};

export interface CStatLookup {
  cStat: number;
  categoria: CStatCategoria;
  descricao: string;
}

export function lookupCStat(cStat: number | null | undefined): CStatLookup {
  const code = typeof cStat === "number" ? cStat : NaN;
  const info = TABLE[code];
  if (info) {
    return {
      cStat: code,
      categoria: info.categoria,
      descricao: info.descricao,
    };
  }
  // Famílias conhecidas
  if (code >= 200 && code < 600) {
    return {
      cStat: code,
      categoria: "rejeitada",
      descricao: `Rejeicao (cStat ${code})`,
    };
  }
  if (code >= 100 && code < 200) {
    return {
      cStat: code,
      categoria: "desconhecido",
      descricao: `Sucesso parcial nao mapeado (cStat ${code})`,
    };
  }
  return {
    cStat: code,
    categoria: "desconhecido",
    descricao: `cStat desconhecido: ${code}`,
  };
}

/**
 * Atalho usado por consultarStatusServico — retorna true só para cStat=107.
 */
export function isServicoOperacional(cStat: number | null | undefined): boolean {
  return lookupCStat(cStat).categoria === "servico_operacional";
}
