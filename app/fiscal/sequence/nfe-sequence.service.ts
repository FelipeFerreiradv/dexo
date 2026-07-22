import prisma from "../../lib/prisma";
import { FiscalAmbiente } from "../domain/nfe.types";

/**
 * Serviço de numeração atômica de NF-e.
 *
 * Usa `SELECT ... FOR UPDATE` dentro de `prisma.$transaction` para garantir
 * que dois requests simultâneos nunca recebam o mesmo número.
 *
 * Cada combinação (userId, ambiente, serie, modelo) possui seu próprio counter.
 * `modelo` (Fase 2 — NFC-e) é ADITIVO: default "55" mantém a numeração da
 * NF-e byte-idêntica; o modelo 65 ganha contadores independentes por série.
 *
 * Multi-CNPJ: com `opts` presente, o counter passa a ser POR EMITENTE
 * (companyFiscalConfigId) — numeração fiscal é por CNPJ. Linhas legadas
 * (configId NULL, da era 1-CNPJ) pertencem ao CNPJ padrão e são ADOTADAS
 * (ganham o configId) na primeira reserva, preservando o contador de onde
 * parou. SEM `opts`, o caminho é o legado, byte-idêntico ao anterior.
 */
export interface SequenceEmitterOpts {
  companyFiscalConfigId: string;
  /**
   * true ⇒ este emitente é o CNPJ padrão do tenant e pode ADOTAR linhas
   * legadas com configId NULL (elas pertencem à era 1-CNPJ = padrão).
   * Emitente não-padrão NUNCA adota linha NULL — começa contador próprio.
   */
  isDefaultConfig: boolean;
}

export class NfeSequenceService {
  /**
   * Reserva o próximo número disponível para a série/ambiente/userId/modelo.
   * Cria o registro NfeSequence automaticamente se não existir (parte do 1).
   *
   * @returns O número reservado (já incrementado no banco).
   */
  async reservarProximoNumero(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    modelo: "55" | "65" = "55",
    opts?: SequenceEmitterOpts,
  ): Promise<number> {
    if (!userId) throw new Error("userId é obrigatório");
    if (serie < 0 || !Number.isInteger(serie))
      throw new Error("Série deve ser um inteiro não-negativo");
    if (opts && !opts.companyFiscalConfigId)
      throw new Error("companyFiscalConfigId é obrigatório quando informado");

    if (opts) {
      return this.reservarPorEmitente(userId, ambiente, serie, modelo, opts);
    }

    return prisma.$transaction(async (tx) => {
      // Tenta buscar o registro com lock exclusivo via raw query
      const rows = await tx.$queryRawUnsafe<
        { id: string; proximoNumero: number }[]
      >(
        `SELECT "id", "proximoNumero"
         FROM "NfeSequence"
         WHERE "userId" = $1 AND "ambiente" = $2 AND "serie" = $3 AND "modelo" = $4
         FOR UPDATE`,
        userId,
        ambiente,
        serie,
        modelo,
      );

      if (rows.length > 0) {
        const numero = rows[0].proximoNumero;

        await tx.$queryRawUnsafe(
          `UPDATE "NfeSequence"
           SET "proximoNumero" = $1, "updatedAt" = NOW()
           WHERE "id" = $2`,
          numero + 1,
          rows[0].id,
        );

        return numero;
      }

      // Primeira emissão nesta combinação — cria registro começando em 1.
      // ON CONFLICT SEM alvo explícito: vale contra qualquer unique da tabela
      // (desacopla o código da forma exata do índice durante o deploy).
      await tx.$queryRawUnsafe(
        `INSERT INTO "NfeSequence" ("id", "userId", "ambiente", "serie", "modelo", "proximoNumero", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 2, NOW())
         ON CONFLICT DO NOTHING`,
        userId,
        ambiente,
        serie,
        modelo,
      );

      // Se houve conflito (race raro no INSERT), refaz o SELECT FOR UPDATE
      const retry = await tx.$queryRawUnsafe<
        { id: string; proximoNumero: number }[]
      >(
        `SELECT "id", "proximoNumero"
         FROM "NfeSequence"
         WHERE "userId" = $1 AND "ambiente" = $2 AND "serie" = $3 AND "modelo" = $4
         FOR UPDATE`,
        userId,
        ambiente,
        serie,
        modelo,
      );

      if (retry.length > 0 && retry[0].proximoNumero > 1) {
        // Outro request ganhou a race e já incrementou — pegar o número atual
        const numero = retry[0].proximoNumero;
        await tx.$queryRawUnsafe(
          `UPDATE "NfeSequence"
           SET "proximoNumero" = $1, "updatedAt" = NOW()
           WHERE "id" = $2`,
          numero + 1,
          retry[0].id,
        );
        return numero;
      }

      // Nós criamos o registro, número 1 é nosso
      return 1;
    });
  }

  /**
   * Caminho multi-CNPJ: counter por emitente, com adoção idempotente da linha
   * legada (configId NULL) quando o emitente é o padrão do tenant.
   *
   * ORDER BY ("companyFiscalConfigId" IS NULL) ASC: se coexistirem a linha já
   * adotada E uma linha NULL (criada por código velho na janela de deploy),
   * preferimos a adotada — a NULL fica inerte até o sweep do SQL-2.
   */
  private async reservarPorEmitente(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    modelo: "55" | "65",
    opts: SequenceEmitterOpts,
  ): Promise<number> {
    const selectSql = `SELECT "id", "proximoNumero"
         FROM "NfeSequence"
         WHERE "userId" = $1 AND "ambiente" = $2 AND "serie" = $3 AND "modelo" = $4
           AND ("companyFiscalConfigId" = $5
                OR ($6 AND "companyFiscalConfigId" IS NULL))
         ORDER BY ("companyFiscalConfigId" IS NULL) ASC
         LIMIT 1
         FOR UPDATE`;

    return prisma.$transaction(async (tx) => {
      const lockAndBump = async (): Promise<number | null> => {
        const rows = await tx.$queryRawUnsafe<
          { id: string; proximoNumero: number }[]
        >(
          selectSql,
          userId,
          ambiente,
          serie,
          modelo,
          opts.companyFiscalConfigId,
          opts.isDefaultConfig,
        );
        if (rows.length === 0) return null;
        const numero = rows[0].proximoNumero;
        // UPDATE também grava o configId — adoção idempotente da linha legada.
        await tx.$queryRawUnsafe(
          `UPDATE "NfeSequence"
           SET "proximoNumero" = $1, "companyFiscalConfigId" = $2, "updatedAt" = NOW()
           WHERE "id" = $3`,
          numero + 1,
          opts.companyFiscalConfigId,
          rows[0].id,
        );
        return numero;
      };

      const reserved = await lockAndBump();
      if (reserved !== null) return reserved;

      // Primeira emissão deste emitente nesta combinação. ON CONFLICT sem alvo:
      // captura tanto o unique novo (parcial por configId) quanto o antigo por
      // userId (ainda de pé na janela entre PR-1 e SQL-2). RETURNING distingue
      // "inserimos" (número 1 é nosso — SEM refazer o SELECT, que enxergaria a
      // própria linha recém-criada e devolveria 2, pulando o nº 1) de
      // "conflitou" (alguém/algo já tem a linha — adotar via retry).
      const inserted = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "NfeSequence" ("id", "userId", "ambiente", "serie", "modelo", "proximoNumero", "companyFiscalConfigId", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 2, $5, NOW())
         ON CONFLICT DO NOTHING
         RETURNING "id"`,
        userId,
        ambiente,
        serie,
        modelo,
        opts.companyFiscalConfigId,
      );
      if (Array.isArray(inserted) && inserted.length > 0) {
        // Nós criamos o registro, número 1 é nosso.
        return 1;
      }

      // Conflito (race ou unique antigo por userId): refaz o SELECT NOVO (com
      // o ramo OR NULL) — adota a linha existente em vez de duplicar número.
      // NUNCA usar o SELECT legado aqui: ele ignoraria o filtro por emitente.
      const retried = await lockAndBump();
      if (retried !== null) return retried;

      // INSERT conflitou mas o SELECT filtrado não enxerga a linha conflitante
      // (ex.: linha legada NULL de um emitente que não pode adotá-la — janela
      // pré-SQL-2 com config fora do padrão). Falhar ALTO: devolver um número
      // aqui arriscaria duplicidade de nNF na SEFAZ.
      throw new Error(
        "Não foi possível reservar número para o emitente — numeração em migração (ver docs/multi-cnpj-sql.md)",
      );
    });
  }

  /**
   * Consulta o próximo número sem reservar (read-only, sem lock).
   *
   * Reescrito de findUnique→findFirst: o @@unique antigo por userId saiu do
   * schema (multi-CNPJ) e o input composto some do client. Sem `opts`, tenant
   * com 1 config tem no máximo 1 linha por combinação — resultado idêntico.
   */
  async consultarProximoNumero(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    modelo: "55" | "65" = "55",
    opts?: SequenceEmitterOpts,
  ): Promise<number> {
    const row = await (prisma as any).nfeSequence.findFirst({
      where: this.buildWhere(userId, ambiente, serie, modelo, opts),
      select: { proximoNumero: true },
      // ASC (NULLS LAST no Postgres): prefere a linha já adotada à legada NULL.
      orderBy: { companyFiscalConfigId: "asc" },
    });
    return row?.proximoNumero ?? 1;
  }

  /**
   * Define manualmente o próximo número (para inutilização de faixa).
   * Só permite avançar, nunca retroceder.
   */
  async ajustarProximoNumero(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    novoNumero: number,
    modelo: "55" | "65" = "55",
    opts?: SequenceEmitterOpts,
  ): Promise<void> {
    if (novoNumero < 1 || !Number.isInteger(novoNumero))
      throw new Error("Número deve ser um inteiro positivo");

    const atual = await this.consultarProximoNumero(
      userId,
      ambiente,
      serie,
      modelo,
      opts,
    );
    if (novoNumero <= atual) {
      throw new Error(
        `Novo número (${novoNumero}) deve ser maior que o atual (${atual})`,
      );
    }

    // Reescrito de upsert→findFirst+update/create (input composto saiu do
    // client). Com `opts`, o update também adota a linha legada (configId).
    const existing = await (prisma as any).nfeSequence.findFirst({
      where: this.buildWhere(userId, ambiente, serie, modelo, opts),
      select: { id: true },
      orderBy: { companyFiscalConfigId: "asc" },
    });

    if (existing) {
      await (prisma as any).nfeSequence.update({
        where: { id: existing.id },
        data: {
          proximoNumero: novoNumero,
          ...(opts
            ? { companyFiscalConfigId: opts.companyFiscalConfigId }
            : {}),
        },
      });
      return;
    }

    try {
      await (prisma as any).nfeSequence.create({
        data: {
          userId,
          ambiente,
          serie,
          modelo,
          proximoNumero: novoNumero,
          ...(opts
            ? { companyFiscalConfigId: opts.companyFiscalConfigId }
            : {}),
        },
      });
    } catch (err: any) {
      // Corrida findFirst→create (o upsert antigo era atômico pela unique
      // composta): outra transação criou a linha no meio. Reaplica como
      // update — ajustar só avança, então repetir é seguro.
      if (err?.code !== "P2002") throw err;
      const raced = await (prisma as any).nfeSequence.findFirst({
        where: this.buildWhere(userId, ambiente, serie, modelo, opts),
        select: { id: true, proximoNumero: true },
        orderBy: { companyFiscalConfigId: "asc" },
      });
      if (!raced) throw err;
      if (raced.proximoNumero < novoNumero) {
        await (prisma as any).nfeSequence.update({
          where: { id: raced.id },
          data: {
            proximoNumero: novoNumero,
            ...(opts
              ? { companyFiscalConfigId: opts.companyFiscalConfigId }
              : {}),
          },
        });
      }
    }
  }

  private buildWhere(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    modelo: "55" | "65",
    opts?: SequenceEmitterOpts,
  ): Record<string, unknown> {
    const base = { userId, ambiente, serie, modelo };
    if (!opts) return base;
    return {
      ...base,
      OR: [
        { companyFiscalConfigId: opts.companyFiscalConfigId },
        // Linha legada (era 1-CNPJ) pertence ao padrão do tenant.
        ...(opts.isDefaultConfig ? [{ companyFiscalConfigId: null }] : []),
      ],
    };
  }
}
