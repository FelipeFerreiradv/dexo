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
 */
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
  ): Promise<number> {
    if (!userId) throw new Error("userId é obrigatório");
    if (serie < 0 || !Number.isInteger(serie))
      throw new Error("Série deve ser um inteiro não-negativo");

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
   * Consulta o próximo número sem reservar (read-only, sem lock).
   */
  async consultarProximoNumero(
    userId: string,
    ambiente: FiscalAmbiente,
    serie: number,
    modelo: "55" | "65" = "55",
  ): Promise<number> {
    const row = await (prisma as any).nfeSequence.findUnique({
      where: {
        userId_ambiente_serie_modelo: { userId, ambiente, serie, modelo },
      },
      select: { proximoNumero: true },
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
  ): Promise<void> {
    if (novoNumero < 1 || !Number.isInteger(novoNumero))
      throw new Error("Número deve ser um inteiro positivo");

    const atual = await this.consultarProximoNumero(
      userId,
      ambiente,
      serie,
      modelo,
    );
    if (novoNumero <= atual) {
      throw new Error(
        `Novo número (${novoNumero}) deve ser maior que o atual (${atual})`,
      );
    }

    await (prisma as any).nfeSequence.upsert({
      where: {
        userId_ambiente_serie_modelo: { userId, ambiente, serie, modelo },
      },
      create: {
        userId,
        ambiente,
        serie,
        modelo,
        proximoNumero: novoNumero,
      },
      update: {
        proximoNumero: novoNumero,
      },
    });
  }
}
