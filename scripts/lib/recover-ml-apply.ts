/**
 * Gravação CONDICIONAL do `--apply` do script de recuperação
 * (scripts/recover-ml-failed-listings.ts).
 *
 * Só grava se a linha continua EXATAMENTE como o dry-run a leu: mesmo
 * `updatedAt` e ainda placeholder `PENDING_`. Linha que mudou no meio — o cron
 * publicou, alguém clicou em "Tentar publicar novamente", a criação a reservou
 * — é pulada, nunca sobrescrita (sobrescrever uma linha recém-publicada
 * devolvia ao cron algo que ele criaria de novo).
 *
 * Depende de TODA escrita na linha mudar o `updatedAt` — inclusive os
 * `updateMany` das reservas; provado contra Postgres real em
 * tests/it/recover-ml-gravacao.it.spec.ts.
 *
 * Separado do script porque o script chama `main()` no topo e não pode ser
 * importado por teste.
 */
export async function gravarSeIntacta(
  db: {
    productListing: {
      updateMany: (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
  },
  listingId: string,
  lidoEm: Date | undefined,
  data: Record<string, unknown>,
): Promise<boolean> {
  // Sem a leitura não há como provar que a linha está intacta: não grava.
  if (!lidoEm) return false;
  const r = await db.productListing.updateMany({
    where: {
      id: listingId,
      updatedAt: lidoEm,
      externalListingId: { startsWith: "PENDING_" },
    },
    data,
  });
  return r.count === 1;
}
