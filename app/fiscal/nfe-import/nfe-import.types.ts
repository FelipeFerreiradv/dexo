/**
 * Tipos do parser de importação de NF-e (modelo 55, leiaute 4.00).
 *
 * Este módulo é PURO e independente do Fastify/Prisma: recebe o XML da nota de
 * COMPRA do fornecedor e devolve um JSON normalizado para pré-preencher o modal
 * de criação de produto. Nada aqui é persistido — só o que mapeia direto para
 * campos já existentes em `Product` é aproveitado (name, costPrice, stock).
 *
 * Campos fiscais POR ITEM (NCM, CFOP, impostos da linha) continuam
 * intencionalmente ignorados — por isso NÃO reusamos `NfeItemInput` de
 * `../domain/nfe.types`, que é orientado à emissão/saída.
 *
 * ⭐ O CABEÇALHO FISCAL DA NOTA, porém, passou a ser extraído (13/08/2026), e o
 * motivo é concreto: o Bitz ganhou uma ferramenta para preencher o bloco fiscal
 * da SUCATA a partir da nota do veículo arrematado, e ela pedia ao modelo para
 * "copiar os valores da leitura do anexo" — valores que o parser nunca havia
 * extraído. O lojista anexava o XML e recebia um cartão com o número da nota e
 * mais nada.
 *
 * São todos OPCIONAIS e a extração NUNCA lança: nota sem `Id`, sem `vICMS` ou
 * com data em leiaute antigo continua importando produto exatamente como antes.
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

    // ── CABEÇALHO FISCAL ────────────────────────────────────────────────
    /**
     * Os 44 dígitos de `infNFe/@Id`, sem o prefixo `NFe`.
     *
     * ⚠️ SÓ EXTRAÍDA, NUNCA VALIDADA AQUI. A chave tem dígito verificador
     * (módulo 11), e conferi-lo NESTE parser seria uma mudança de
     * comportamento na importação de produtos que existe desde antes: uma nota
     * com chave torta deixaria de importar item nenhum. Quem confere o dígito é
     * quem VAI GRAVAR a chave (`completar_fiscal_da_sucata`, via `parseChave`).
     * Extração é aditiva; validação é decisão de quem usa.
     */
    accessKey?: string;
    /** `emit/CNPJ` — só dígitos. Nota emitida por pessoa física não tem. */
    emitCnpj?: string;
    /** `ide/serie`. */
    serie?: string;
    /** Data de emissão em `AAAA-MM-DD` (de `ide/dhEmi` 4.00 ou `ide/dEmi` 3.10). */
    issueDate?: string;
    /** `ide/natOp` — natureza da operação. */
    operationNature?: string;
    /** `total/ICMSTot/vICMS` — valor do ICMS da nota, em reais. */
    icmsValue?: number;

    /** Quantidade de linhas `det` lidas (antes do agrupamento). */
    itemCount: number;
    /** Quantidade de produtos distintos após o agrupamento. */
    groupedCount: number;
  };
}
