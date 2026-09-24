/**
 * ESCOPO DA NUMERAÇÃO FISCAL PARA OS SCRIPTS DE MIGRAÇÃO
 * ======================================================
 *
 * `NfeSequence` é POR CNPJ, não por tenant. A unicidade real vive em uniques
 * PARCIAIS no banco (ver `prisma/schema.prisma` e `docs/multi-cnpj-sql.md`):
 *   (companyFiscalConfigId, ambiente, serie, modelo) WHERE configId IS NOT NULL
 *   (userId, ambiente, serie, modelo)                WHERE configId IS NULL   ← legado
 *
 * O @@unique antigo por `userId` virou índice NORMAL quando o multi-CNPJ
 * entrou: dois CNPJs do mesmo tenant compartilham (ambiente, serie, modelo)
 * sem colidir, e portanto podem existir DUAS linhas para o mesmo `userId`.
 *
 * Os scripts de migração nasceram na era 1-CNPJ e procuram a linha só por
 * (userId, ambiente, serie, modelo). Num tenant com mais de uma
 * `CompanyFiscalConfig` — o VN Motors é exatamente esse caso — o `findFirst`
 * devolve uma linha ARBITRÁRIA: o script pode avançar (ou, no
 * `delete-migrated-nfes`, APAGAR) o contador do OUTRO CNPJ. A falha é
 * silenciosa; ela só aparece na emissão real seguinte, como número queimado
 * ou nNF duplicado na SEFAZ.
 *
 * A regra canônica de quem lê/escreve contador mora em
 * `app/fiscal/sequence/nfe-sequence.service.ts` (V1) e em
 * `app/fiscal/numeracao/numeracao.repository.ts` (V2): filtra por emitente e
 * só ADOTA a linha legada (configId NULL) quando o emitente é o padrão do
 * tenant — emitente não-padrão NUNCA adota, começa contador próprio.
 *
 * Este módulo repete esse recorte para os scripts, com UMA diferença
 * deliberada: script de migração não adivinha. Quando o tenant tem mais de um
 * CNPJ e a origem não diz qual é o emitente, a resolução FALHA com erro claro
 * em vez de escolher — errar aqui é irreversível do lado da SEFAZ, e abortar
 * custa só uma flag a mais na linha de comando.
 */

/** Linha de `CompanyFiscalConfig` no recorte que a resolução precisa. */
export interface ConfigFiscalDoTenant {
  id: string;
  cnpj: string;
  isDefault: boolean;
}

/**
 * `SEM_CONFIG` = tenant sem nenhuma `CompanyFiscalConfig`. Aí o recorte fica
 * EXATAMENTE como era antes desta correção (só userId/ambiente/serie/modelo):
 * sem config não existe linha por emitente, e qualquer filtro novo só criaria
 * uma segunda linha à toa.
 */
export type EscopoSequencia =
  | {
      tipo: "SEM_CONFIG";
      companyFiscalConfigId: null;
      adotaLegadoNulo: true;
      motivo: string;
    }
  | {
      tipo: "CONFIG";
      companyFiscalConfigId: string;
      adotaLegadoNulo: boolean;
      motivo: string;
    };

/** CNPJ comparável: a config guarda formatado, a chave de acesso traz cru. */
export function soDigitos(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

/**
 * Decide de QUAL emitente é o contador que o script vai mexer.
 *
 * Ordem: `configId` explícito > CNPJ (da chave de acesso ou de `--cnpj`) >
 * única config do tenant. Sem nenhum desses caminhos num tenant multi-CNPJ,
 * LANÇA — ver o cabeçalho para o porquê de não haver fallback.
 */
export function resolverEscopoSequencia(
  configs: ConfigFiscalDoTenant[],
  dica: { configId?: string | null; cnpj?: string | null } = {},
): EscopoSequencia {
  const lista = configs ?? [];
  const rotulo = () =>
    lista.map((c) => `${c.cnpj}${c.isDefault ? " (padrão)" : ""}`).join(", ");

  // 1) O operador disse qual é. Escopar pelo tenant é obrigatório: id de outro
  //    tenant não pode virar alvo de escrita por digitação errada.
  const configId = (dica.configId ?? "").trim();
  if (configId) {
    const achada = lista.find((c) => c.id === configId);
    if (!achada) {
      throw new Error(
        `--config-id=${configId} não é uma CompanyFiscalConfig deste tenant. ` +
          `Configs do tenant: ${lista.length ? rotulo() : "(nenhuma)"}.`,
      );
    }
    return {
      tipo: "CONFIG",
      companyFiscalConfigId: achada.id,
      // Emitente não-padrão nunca adota a linha legada (mesma regra do serviço).
      adotaLegadoNulo: achada.isDefault || lista.length === 1,
      motivo: `--config-id (CNPJ ${achada.cnpj})`,
    };
  }

  // 2) Tenant sem config fiscal: recorte legado, byte-idêntico ao anterior.
  if (lista.length === 0) {
    return {
      tipo: "SEM_CONFIG",
      companyFiscalConfigId: null,
      adotaLegadoNulo: true,
      motivo: "tenant sem CompanyFiscalConfig (recorte legado)",
    };
  }

  // 3) Um CNPJ só: a linha legada (configId NULL) só pode ser dele, então ela
  //    é adotável mesmo se `isDefault` estiver false (o parcial garante no
  //    máximo um default, não ao menos um).
  if (lista.length === 1) {
    return {
      tipo: "CONFIG",
      companyFiscalConfigId: lista[0].id,
      adotaLegadoNulo: true,
      motivo: `única config do tenant (CNPJ ${lista[0].cnpj})`,
    };
  }

  // 4) Multi-CNPJ: só resolve se o CNPJ do emitente casar com UMA config.
  const cnpj = soDigitos(dica.cnpj);
  if (cnpj) {
    const casadas = lista.filter((c) => soDigitos(c.cnpj) === cnpj);
    if (casadas.length === 1) {
      return {
        tipo: "CONFIG",
        companyFiscalConfigId: casadas[0].id,
        adotaLegadoNulo: casadas[0].isDefault,
        motivo: `CNPJ do emitente ${casadas[0].cnpj}`,
      };
    }
    throw new Error(
      `O CNPJ ${cnpj} ${casadas.length === 0 ? "não corresponde a nenhuma" : `corresponde a ${casadas.length}`} ` +
        `CompanyFiscalConfig deste tenant (${rotulo()}). ` +
        `NfeSequence é POR CNPJ — o script não vai adivinhar qual contador mexer. ` +
        `Informe --config-id=<id> da empresa emitente.`,
    );
  }

  throw new Error(
    `Este tenant tem ${lista.length} CNPJs em CompanyFiscalConfig (${rotulo()}) e a origem ` +
      `não diz de qual é a numeração. NfeSequence é POR CNPJ: escolher errado avança ou apaga, ` +
      `em silêncio, o contador de OUTRA empresa — e o estrago só aparece na próxima emissão ` +
      `real, como número queimado ou nNF duplicado na SEFAZ. ` +
      `Informe --config-id=<id> (ou --cnpj=<14 dígitos>) da empresa emitente.`,
  );
}

/** Chave da linha de contador, sem o recorte por emitente. */
export interface ChaveSequencia {
  userId: string;
  ambiente: string;
  serie: number;
  modelo: string;
}

/**
 * `where` do `findFirst` já com o recorte por emitente — mesma forma do
 * `buildWhere` do `NfeSequenceService`.
 */
export function whereSequencia(
  base: ChaveSequencia,
  escopo: EscopoSequencia,
): ChaveSequencia & { OR?: Array<{ companyFiscalConfigId: string | null }> } {
  if (escopo.tipo === "SEM_CONFIG") return { ...base };
  return {
    ...base,
    OR: [
      { companyFiscalConfigId: escopo.companyFiscalConfigId },
      ...(escopo.adotaLegadoNulo
        ? [{ companyFiscalConfigId: null as string | null }]
        : []),
    ],
  };
}

/**
 * `orderBy` obrigatório junto do `where` acima: ASC é NULLS LAST no Postgres,
 * então a linha já adotada (configId preenchido) ganha da legada NULL que
 * tenha sobrado da janela de deploy. Mesma ordenação do serviço.
 */
export const ORDEM_SEQUENCIA = { companyFiscalConfigId: "asc" } as const;

/**
 * Campos extras do `create`: linha nova já nasce carimbada com o emitente,
 * senão a próxima emissão real (que filtra por configId) não a enxerga e
 * recomeça o contador do 1.
 */
export function dadosDoEmitente(
  escopo: EscopoSequencia,
): { companyFiscalConfigId?: string } {
  return escopo.tipo === "CONFIG"
    ? { companyFiscalConfigId: escopo.companyFiscalConfigId }
    : {};
}

/**
 * Lê as configs do tenant. `as any` segue a convenção do repositório
 * (`app/repositories/company-fiscal.repository.ts`): o client gerado pode
 * estar defasado numa janela de deploy e `isDefault` some da tipagem.
 */
export async function carregarConfigsFiscais(
  client: unknown,
  userId: string,
): Promise<ConfigFiscalDoTenant[]> {
  const rows = await (client as any).companyFiscalConfig.findMany({
    where: { userId },
    select: { id: true, cnpj: true, isDefault: true },
    orderBy: [{ isDefault: "desc" }, { cnpj: "asc" }],
  });
  return (rows as ConfigFiscalDoTenant[]).map((r) => ({
    id: r.id,
    cnpj: r.cnpj,
    isDefault: Boolean(r.isDefault),
  }));
}
