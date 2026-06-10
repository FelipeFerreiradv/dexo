/**
 * Tipos do parser de importação de NF-e (modelo 55, leiaute 4.00).
 *
 * Este módulo é PURO e independente do Fastify/Prisma: recebe o XML da nota de
 * COMPRA do fornecedor e devolve um JSON normalizado para pré-preencher o modal
 * de criação de produto. Nada aqui é persistido — só o que mapeia direto para
 * campos já existentes em `Product` é aproveitado (name, costPrice, stock).
 *
 * Campos fiscais (NCM, CFOP, emitente, chave, impostos) são intencionalmente
 * ignorados nesta versão (decisão de produto), por isso NÃO reusamos
 * `NfeItemInput` de `../domain/nfe.types`, que é orientado à emissão/saída.
 */

/** Um item da nota já agrupado por (cProd + cEAN + xProd) e com quantidades somadas. */
export interface NfeParsedItem {
  /** Chave de agrupamento `cProd|cEAN|xProd`. Apenas interna — não persistida. */
  groupKey: string;
  /** `prod/xProd` truncado a 60 caracteres (limite do schema do produto). */
  name: string;
  /** `prod/xProd` completo, para exibição (pode virar `description` se o usuário quiser). */
  fullName: string;
  /** Custo unitário = soma(vProd) / soma(qCom), arredondado a 2 casas. Vira `costPrice`. */
  costPrice: number;
  /** Soma de `qCom` do grupo, arredondada para inteiro. Vira `stock`. */
  quantity: number;
  /** `prod/uCom` — unidade comercial, só para exibição/conferência. */
  unit: string;
  /** Soma de `vProd` do grupo (custo total), apenas para conferência. */
  lineTotal: number;
}

/** Resultado normalizado do parser da NF-e. */
export interface NfeParsedResult {
  items: NfeParsedItem[];
  meta: {
    /** `ide/nNF` — número da nota (exibição). */
    numero?: string;
    /** `emit/xNome` — nome do fornecedor (exibição). */
    emitName?: string;
    /** Quantidade de linhas `det` lidas (antes do agrupamento). */
    itemCount: number;
    /** Quantidade de produtos distintos após o agrupamento. */
    groupedCount: number;
  };
}
