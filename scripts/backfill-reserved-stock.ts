import prisma from "../app/lib/prisma";
import {
  availableForSale,
  describeAvailability,
  isStockReservationEnabled,
  isStockReservationSyncEnabled,
} from "../app/financeiro/lib/stock-reservation";
import { recomputeReservedStockWithinTx } from "../app/marketplaces/services/stock-reservation.service";

/**
 * BLOCO G — backfill do estoque comprometido por vendas JÁ ABERTAS.
 *
 * POR QUE ISTO EXISTE: o recálculo só roda quando a venda é TOCADA (criada,
 * editada, recebida, excluída). Ligar a flag não reserva retroativamente nada —
 * uma venda fiado aberta há 42 dias continuaria com a peça anunciada, que é
 * exatamente o problema que a reserva existe para resolver. Sem este script, o
 * passivo atual segue sangrando até alguém mexer em cada venda uma a uma.
 *
 * O QUE ELE NÃO FAZ: não inventa lógica própria. Ele chama a MESMA
 * `recomputeReservedStockWithinTx` que os quatro caminhos de venda chamam, com
 * os mesmos filtros de status. Um backfill que recalcula "do seu jeito" é como
 * se cria divergência entre o histórico e o corrente.
 *
 * Uso:
 *   tsx scripts/backfill-reserved-stock.ts                     # dry-run global
 *   tsx scripts/backfill-reserved-stock.ts --email a@b.com     # dry-run do tenant
 *   tsx scripts/backfill-reserved-stock.ts --email a@b.com --apply
 *
 * ⚠️ NUNCA chame por `npm run`: o npm engole as flags (inclusive o `--apply`) e
 * o script roda em dry-run silencioso — ou pior, sem o filtro de tenant.
 */

// ── Flags, no padrão da casa ──────────────────────────────────────────────
const argv = process.argv.slice(2);
const CONHECIDAS = new Set([
  "apply",
  "dry-run",
  "user-id",
  "email",
  "lote",
  "help",
]);

function valorDe(nome: string): string | undefined {
  const pref = `--${nome}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length);
  const i = argv.indexOf(`--${nome}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--"))
    return argv[i + 1];
  return undefined;
}
const tem = (nome: string) =>
  argv.includes(`--${nome}`) || argv.some((a) => a.startsWith(`--${nome}=`));

// Flag desconhecida ABORTA: uma `--aply` com typo falharia para o lado errado,
// rodando um apply global achando que era dry-run de um tenant.
for (const a of argv) {
  if (!a.startsWith("--")) continue;
  const nome = a.slice(2).split("=")[0];
  if (!CONHECIDAS.has(nome)) {
    console.error(
      `[abortado] Flag desconhecida: --${nome}. Conhecidas: ${[...CONHECIDAS]
        .map((c) => `--${c}`)
        .join(", ")}`,
    );
    process.exit(1);
  }
}

// Mesma regra do resto da casa: --dry-run VENCE --apply.
const apply = tem("apply") && !tem("dry-run");
const userIdArg = valorDe("user-id");
const emailArg = valorDe("email");
const LOTE = Number(valorDe("lote") ?? 25);

const STATUS_ABERTOS = ["PENDENTE", "VENCIDA"] as const;

async function resolverTenant(): Promise<string | null> {
  if (userIdArg) return userIdArg;
  if (emailArg) {
    const u = await prisma.user.findFirst({
      where: { email: emailArg },
      select: { id: true, email: true, parentUserId: true },
    });
    if (!u) {
      console.error(`[abortado] Nenhum usuário com email ${emailArg}`);
      process.exit(1);
    }
    // As contas a receber ficam sempre no DONO (verificado em 25/08: 0 de 293
    // pertencem a colaborador), então filtrar pelo id do colaborador não
    // acharia venda nenhuma e o script diria "nada a fazer" — falso negativo.
    if (u.parentUserId) {
      console.log(
        `ℹ  ${emailArg} é colaborador; usando o dono do tenant (${u.parentUserId}).`,
      );
      return u.parentUserId;
    }
    return u.id;
  }
  return null;
}

async function run() {
  console.log("─".repeat(72));
  console.log("BLOCO G — backfill de estoque comprometido");
  console.log("─".repeat(72));

  // As flags do PROCESSO importam: sem elas o recompute é no-op e o script
  // mentiria dizendo "0 produtos atualizados".
  const flagOn = isStockReservationEnabled();
  const syncOn = isStockReservationSyncEnabled();
  console.log(
    `STOCK_RESERVATION_ENABLED      = ${flagOn ? "1 (ON)" : "(OFF)"}`,
  );
  console.log(
    `STOCK_RESERVATION_SYNC_ENABLED = ${syncOn ? "1 (ON)" : "(OFF)"}`,
  );
  if (apply && !flagOn) {
    console.error(
      "\n[abortado] --apply sem STOCK_RESERVATION_ENABLED=1 gravaria ZERO e daria" +
        "\n           a impressão de que o passivo foi tratado. Ligue a flag no" +
        "\n           ambiente onde este script roda.",
    );
    process.exit(1);
  }

  const tenant = await resolverTenant();
  if (apply && !tenant) {
    console.error(
      "\n[abortado] --apply exige --user-id ou --email. Não existe apply global:" +
        "\n           a propagação toca anúncios de verdade, e o raio de uma" +
        "\n           execução precisa caber na cabeça de quem a dispara.",
    );
    process.exit(1);
  }
  console.log(`Tenant  : ${tenant ?? "(todos — somente leitura)"}`);
  console.log(`Modo    : ${apply ? "APPLY (grava)" : "DRY-RUN"}`);
  console.log("");

  // ── Levantamento ────────────────────────────────────────────────────────
  const itens = await prisma.receivableItem.findMany({
    where: {
      productId: { not: null },
      receivable: {
        status: { in: STATUS_ABERTOS as unknown as any },
        ...(tenant ? { userId: tenant } : {}),
      },
    },
    select: {
      productId: true,
      quantity: true,
      receivable: { select: { id: true, createdAt: true, status: true } },
    },
  });

  if (itens.length === 0) {
    console.log("Nenhuma venda aberta com item de catálogo. Nada a fazer.");
    return;
  }

  const reservaPorProduto = new Map<string, number>();
  const vendasPorProduto = new Map<string, Set<string>>();
  for (const it of itens) {
    const pid = it.productId!;
    reservaPorProduto.set(pid, (reservaPorProduto.get(pid) ?? 0) + it.quantity);
    if (!vendasPorProduto.has(pid)) vendasPorProduto.set(pid, new Set());
    vendasPorProduto.get(pid)!.add(it.receivable.id);
  }
  const productIds = [...reservaPorProduto.keys()];

  const produtos = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      sku: true,
      name: true,
      userId: true,
      stock: true,
      reservedStock: true,
      listings: {
        select: {
          id: true,
          status: true,
          marketplaceAccount: { select: { platform: true } },
        },
      },
    },
  });

  const vendasDistintas = new Set(itens.map((i) => i.receivable.id));
  console.log(
    `Vendas abertas com item de catálogo : ${vendasDistintas.size}\n` +
      `Produtos distintos segurados       : ${produtos.length}\n` +
      `Unidades comprometidas             : ${[...reservaPorProduto.values()].reduce((a, b) => a + b, 0)}`,
  );
  console.log("");

  // ── Relatório por produto ───────────────────────────────────────────────
  const overReserved: string[] = [];
  const porPlataforma = new Map<string, number>();
  let anunciosAfetados = 0;

  console.log(
    "PRODUTO                                  ESTOQUE  RESERVA  DISPONÍVEL  ANÚNCIOS",
  );
  console.log("─".repeat(96));
  for (const p of produtos) {
    const reserva = reservaPorProduto.get(p.id) ?? 0;
    const antes = availableForSale(p.stock, p.reservedStock);
    const depois = availableForSale(p.stock, reserva);
    const over = reserva > p.stock;
    if (over) overReserved.push(`${p.sku} — ${p.name}`);

    const ativos = p.listings.filter(
      (l) => (l.status ?? "").toLowerCase() === "active",
    );
    if (antes !== depois) {
      anunciosAfetados += ativos.length;
      for (const l of ativos) {
        const plat = l.marketplaceAccount?.platform ?? "?";
        porPlataforma.set(plat, (porPlataforma.get(plat) ?? 0) + 1);
      }
    }

    const rotulo = `${p.sku} ${p.name}`.slice(0, 38).padEnd(40);
    console.log(
      `${rotulo} ${String(p.stock).padStart(7)}  ${String(reserva).padStart(7)}  ` +
        `${String(antes).padStart(4)} → ${String(depois).padEnd(4)}  ` +
        `${ativos.length} ativo(s)${over ? "   ⚠ OVER-RESERVED" : ""}`,
    );
  }
  console.log("");

  if (overReserved.length > 0) {
    console.log(
      `⚠  ${overReserved.length} produto(s) OVER-RESERVED (reserva > estoque físico).`,
    );
    console.log(
      "   A venda dupla JÁ aconteceu neles — ou a peça saiu por outro canal.",
    );
    console.log(
      "   O backfill NÃO os piora: `availableForSale` clampa em 0 e o anúncio",
    );
    console.log(
      "   já estaria pausado. Ficam listados para conferência humana:",
    );
    for (const o of overReserved) console.log(`     · ${o}`);
    console.log("");
  }

  console.log(
    `Anúncios ATIVOS que mudariam de estoque anunciado: ${anunciosAfetados}`,
  );
  for (const [plat, n] of [...porPlataforma.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    const nota =
      plat === "OLX"
        ? "  ⚠ OLX DESPUBLICA (deleteAd) quando o disponível chega a 0"
        : plat === "FACEBOOK"
          ? "  (marca out-of-stock; o item permanece no catálogo)"
          : "";
    console.log(`   ${plat.padEnd(16)} ${String(n).padStart(4)}${nota}`);
  }
  console.log("");

  if (!apply) {
    console.log(
      "DRY-RUN — nada gravado. Rode com --apply (e --email/--user-id).",
    );
    if (!syncOn) {
      console.log(
        "ℹ  STOCK_RESERVATION_SYNC_ENABLED está OFF: um apply gravaria a coluna\n" +
          "   mas NÃO enfileiraria job nenhum — os anúncios ficariam como estão.",
      );
    }
    return;
  }

  // ── Apply, em lotes ─────────────────────────────────────────────────────
  console.log(`Aplicando em lotes de ${LOTE}...`);
  let gravados = 0;
  let enfileirados = 0;
  const reabrir: Array<{ productId: string; userId: string }> = [];

  for (let i = 0; i < productIds.length; i += LOTE) {
    const lote = productIds.slice(i, i + LOTE);
    // Uma transação por lote: o advisory lock do enfileiramento só vale dentro
    // de uma, e um lote que falha não leva os outros junto.
    const r = await prisma.$transaction(
      (tx) => recomputeReservedStockWithinTx(tx as any, lote),
      { timeout: 60_000, maxWait: 20_000 },
    );
    gravados += lote.length;
    enfileirados += r.enqueued;
    reabrir.push(...r.reopened);
    for (const c of r.changed) {
      const p = produtos.find((x) => x.id === c.productId);
      console.log(
        `   ✓ ${p?.sku ?? c.productId}: disponível ${c.before} → ${c.after}` +
          `  (${describeAvailability(p?.stock ?? 0, reservaPorProduto.get(c.productId) ?? 0)})`,
      );
    }
    console.log(
      `   lote ${Math.floor(i / LOTE) + 1}: ${lote.length} produto(s), ${r.enqueued} job(s)`,
    );
  }

  console.log("");
  console.log(
    `✅ ${gravados} produto(s) recalculado(s); ${enfileirados} job(s) enfileirado(s).`,
  );
  if (reabrir.length > 0) {
    console.log(
      `ℹ  ${reabrir.length} produto(s) teriam anúncio REABERTO — o backfill não\n` +
        "   reabre nada por conta própria (só o fluxo de venda faz isso):",
    );
    for (const p of reabrir) console.log(`     · ${p.productId}`);
  }
  console.log(
    "\nOs jobs são duráveis: o StockSyncRetryService do servidor os processa no\n" +
      'próximo tick (30s). Acompanhe por `SELECT * FROM "StockSyncJob"`.',
  );
}

run()
  .catch((e) => {
    console.error("[erro]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
