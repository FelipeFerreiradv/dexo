/**
 * Reabre a pendencia de ingestao de pedido que existe com ZERO itens.
 *
 * POR QUE EXISTE
 *
 * Entre 29/07 e 31/07/2026 o `retryStockDeduction` devolvia `true` para pedido
 * sem item nenhum ("nada a baixar, nenhuma excecao"), e o reconciliador usa esse
 * retorno para FECHAR a pendencia. Resultado medido no banco de producao em
 * 30/07/2026, as 00:24 e 00:35 UTC (duas voltas do reconciliador, antes do
 * deploy da correcao):
 *
 *   77 pendencias do ML fechadas como RESOLVED sobre um `Order` PAID de ZERO
 *   itens, R$ 25.622,00 de faturamento, 8 tenants.
 *
 * Fechada a pendencia, a venda saiu da aba de Pendencias do cliente: nao ha
 * item, nao houve baixa de estoque, e nada mais no sistema aponta para ela. E o
 * estado terminal silencioso que o invariante proibe — so que ja consumado.
 *
 * Ha tambem 7 pedidos do ML de marco/2026 com zero itens que NUNCA tiveram
 * pendencia (sao anteriores a quarentena existir).
 *
 * O QUE FAZ
 *
 * Para todo `Order` com zero itens e status <> CANCELLED:
 *   - pendencia RESOLVED  -> volta para OPEN, com detalhe explicando;
 *   - pendencia inexistente -> cria OPEN com reason NO_LINKED_ITEMS;
 *   - pendencia OPEN/NEEDS_ACTION -> nao toca (ja esta visivel).
 *
 * Voltar para OPEN e nao para NEEDS_ACTION de proposito: OPEN faz o poll e o
 * reconciliador olharem o pedido de novo, e o caminho novo
 * (`completarOrderSemItens`) completa sozinho os que ja tem produto cadastrado.
 * Os que continuarem sem produto caminham para NEEDS_ACTION pelo fluxo normal,
 * em 5 tentativas, sem gastar chamada externa (o ramo de ML/Magalu do
 * reconciliador nao chama API).
 *
 * NAO mexe em estoque, nao cria OrderItem, nao apaga nada. O unico efeito e
 * devolver a venda para a tela de Pendencias.
 *
 * USO
 *   npx tsx scripts/reabrir-pendencias-pedido-vazio.ts                 # dry-run (default)
 *   npx tsx scripts/reabrir-pendencias-pedido-vazio.ts --apply
 *   npx tsx scripts/reabrir-pendencias-pedido-vazio.ts --user-id=<id>  # um tenant
 *   npx tsx scripts/reabrir-pendencias-pedido-vazio.ts --platform=MERCADO_LIVRE
 */
import "dotenv/config";
import prisma from "../app/lib/prisma";

const DETALHE_REABERTA =
  "Pendencia reaberta: o pedido existe sem nenhum item vinculado e o estoque nao baixou. Cadastre o produto vendido para o pedido se completar sozinho.";

interface Flags {
  apply: boolean;
  userId?: string;
  platform?: string;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const f = `--${name}=`;
    const x = argv.find((a) => a.startsWith(f));
    return x ? x.slice(f.length) : undefined;
  };
  return {
    // Dry-run e o DEFAULT. Nada muda sem --apply.
    apply: argv.includes("--apply"),
    userId: get("user-id"),
    platform: get("platform"),
  };
}

interface Linha {
  order_id: string;
  external_order_id: string;
  marketplace_account_id: string;
  platform: string;
  status: string;
  total: string;
  criado: string;
  email: string;
  issue_id: string | null;
  issue_status: string | null;
}

async function main() {
  const flags = parseFlags();

  // Escopo por tenant (dataOwnerId = dono da conta de marketplace) e por
  // plataforma, para o suporte poder agir num cliente so.
  const filtros: string[] = [];
  const params: unknown[] = [];
  if (flags.userId) {
    params.push(flags.userId);
    filtros.push(`ma."userId" = $${params.length}`);
  }
  if (flags.platform) {
    params.push(flags.platform);
    filtros.push(`ma.platform::text = $${params.length}`);
  }
  const extra = filtros.length ? ` AND ${filtros.join(" AND ")}` : "";

  const linhas = await prisma.$queryRawUnsafe<Linha[]>(
    `
    SELECT o.id AS order_id,
           o."externalOrderId" AS external_order_id,
           o."marketplaceAccountId" AS marketplace_account_id,
           ma.platform::text AS platform,
           o.status::text AS status,
           o."totalAmount"::text AS total,
           o."createdAt"::text AS criado,
           u.email,
           i.id AS issue_id,
           i.status AS issue_status
    FROM "Order" o
    JOIN "MarketplaceAccount" ma ON ma.id = o."marketplaceAccountId"
    JOIN "User" u ON u.id = ma."userId"
    LEFT JOIN "OrderIngestionIssue" i
      ON i."marketplaceAccountId" = o."marketplaceAccountId"
     AND i."externalOrderId" = o."externalOrderId"
    WHERE NOT EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."orderId" = o.id)
      AND o.status <> 'CANCELLED'${extra}
    ORDER BY u.email, o."createdAt"
  `,
    ...params,
  );

  const reabrir = linhas.filter((l) => l.issue_status === "RESOLVED");
  const criar = linhas.filter((l) => l.issue_id === null);
  const jaVisiveis = linhas.filter(
    (l) => l.issue_status === "OPEN" || l.issue_status === "NEEDS_ACTION",
  );

  console.log(
    `\nPedidos sem item nenhum (status <> CANCELLED): ${linhas.length}`,
  );
  console.log(`  pendencia fechada em falso (vai reabrir): ${reabrir.length}`);
  console.log(`  sem pendencia nenhuma (vai criar):        ${criar.length}`);
  console.log(`  ja visiveis (nao toca):                   ${jaVisiveis.length}`);

  const porCliente = new Map<string, { qtd: number; valor: number }>();
  for (const l of [...reabrir, ...criar]) {
    const atual = porCliente.get(l.email) ?? { qtd: 0, valor: 0 };
    atual.qtd += 1;
    atual.valor += Number(l.total ?? 0);
    porCliente.set(l.email, atual);
  }
  if (porCliente.size) {
    console.log("\nPor cliente:");
    for (const [email, v] of [...porCliente.entries()].sort(
      (a, b) => b[1].qtd - a[1].qtd,
    )) {
      console.log(
        `  ${email.padEnd(40)} ${String(v.qtd).padStart(4)} pedido(s)  R$ ${v.valor.toFixed(2)}`,
      );
    }
  }

  if (!flags.apply) {
    console.log(
      "\nDRY-RUN (default). Nada foi alterado. Rode com --apply para efetivar.\n",
    );
    return;
  }

  let reabertas = 0;
  for (const l of reabrir) {
    try {
      await (prisma as any).orderIngestionIssue.update({
        where: { id: l.issue_id! },
        data: {
          status: "OPEN",
          reason: "NO_LINKED_ITEMS",
          detail: DETALHE_REABERTA,
          // Zera o backoff: a pendencia volta para a fila agora.
          attempts: 0,
          nextRetryAt: new Date(),
          resolvedOrderId: l.order_id,
        },
      });
      reabertas++;
    } catch (err) {
      console.warn(
        `  falha ao reabrir #${l.external_order_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  let criadas = 0;
  for (const l of criar) {
    try {
      await (prisma as any).orderIngestionIssue.create({
        data: {
          marketplaceAccountId: l.marketplace_account_id,
          platform: l.platform,
          externalOrderId: l.external_order_id,
          reason: "NO_LINKED_ITEMS",
          detail: DETALHE_REABERTA,
          status: "OPEN",
          resolvedOrderId: l.order_id,
          attempts: 0,
          nextRetryAt: new Date(),
        },
      });
      criadas++;
    } catch (err) {
      console.warn(
        `  falha ao criar pendencia de #${l.external_order_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `\nAPLICADO: ${reabertas} pendencia(s) reaberta(s), ${criadas} criada(s).\n`,
  );
}

main()
  .catch((err) => {
    console.error("FALHOU:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
