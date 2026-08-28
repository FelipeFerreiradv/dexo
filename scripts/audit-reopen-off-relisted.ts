/**
 * audit-reopen-off-relisted.ts
 *
 * Varre TODAS as contas e encontra os anúncios que voltaram a ficar VENDÁVEIS
 * depois que o lojista desligou "Reabrir anúncio quando a peça voltar ao
 * estoque". É o passivo do período em que a preferência só suprimia o
 * `updateItem({status:"active"})` — que nunca foi o mecanismo que reabria o
 * anúncio no caminho de cancelamento (quem reabria era o empurrão de
 * quantidade, e o Mercado Livre remove o `out_of_stock` sozinho).
 *
 * PADRÃO: DRY-RUN. Sem `--apply` nada é escrito, nem no banco nem em
 * marketplace nenhum.
 *
 * ── COMO ELE DECIDE (e por que assim) ─────────────────────────────────────
 *
 *  1. QUANDO cada conta desligou. `User.updatedAt` não serve: ele se move a
 *     cada troca de nome, avatar ou senha. A data vem do `SystemLog` de
 *     `USER_ACTIVITY` do `PUT /users/me/settings` cujo corpo TROUXE O CAMPO —
 *     e não do primeiro toque na rota, que costuma ser de meses antes e sem a
 *     chave. Confundir os dois alargaria a janela e encheria a lista de falso
 *     positivo. Sem registro, a conta é varrida desde sempre, e a saída diz.
 *
 *  2. QUAIS peças voltaram por cancelamento. `StockLog` com `reason`
 *     começando em "Estorno venda", `previousStock = 0` e `newStock > 0` —
 *     exatamente o filtro que o motor usa para decidir reabrir
 *     (`stock-deduction.service.ts`: `previousStock === 0 && newStock > 0`).
 *     Restauração que não saiu de zero nunca teve anúncio pausado por falta de
 *     peça e por isso não entra.
 *
 *  3. QUAIS anúncios estão vendáveis HOJE. `status = 'active'` E numa das
 *     plataformas em que a venda REALMENTE tira o anúncio do ar (ML, OLX,
 *     Facebook). Shopee e Magalu ficam fora: ali o anúncio nunca saiu do ar,
 *     só ficou com quantidade 0, e despublicá-lo seria uma ação nova que
 *     nenhuma rotina automática desfaz. Ver
 *     PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE.
 *
 * ── ⚠️ O QUE ESTA LISTA NÃO PROVA ────────────────────────────────────────
 *
 * Que o anúncio esteja no ar indevidamente. A peça pode ter voltado ao pátio
 * de verdade, ou o lojista pode tê-la reativado de propósito depois. Por isso
 * o `--apply` exige alvo explícito e o padrão é só listar.
 *
 * ── COMO ESCREVE, quando escreve ─────────────────────────────────────────
 *
 * Pelo MESMO motor da aplicação (`ListingUseCase.updateListingStatus`), nunca
 * por chamada solta a marketplace: assim a pausa passa pelos mesmos
 * kill-switches de integração, pela mesma validação de posse e pelo mesmo
 * espelho de status local. `forceRemote` porque o status local pode estar
 * velho — é a mesma razão de existir do `force` no caminho de reabertura.
 *
 * Uso:
 *   # 1) Panorama de TODAS as contas (nada é alterado)
 *   npx tsx scripts/audit-reopen-off-relisted.ts --todas-as-contas
 *
 *   # 2) Só as contas elegíveis (preferência DESLIGADA), ainda sem escrever
 *   npx tsx scripts/audit-reopen-off-relisted.ts
 *
 *   # 3) Planilha para conferir com o cliente
 *   npx tsx scripts/audit-reopen-off-relisted.ts --csv > passivo.csv
 *
 *   # 4) Corrigir UMA conta, depois de conferida
 *   npx tsx scripts/audit-reopen-off-relisted.ts --apply --conta cliente@exemplo.com
 *
 *   # 5) Corrigir todas as elegíveis (exige o confirmador explícito)
 *   npx tsx scripts/audit-reopen-off-relisted.ts --apply --sim-todas
 *
 * Flags extras:
 *   --limite N     teto de anúncios alterados nesta execução (padrão 200)
 *   --desde DATA   ignora a data detectada e usa esta (YYYY-MM-DD)
 */

import prisma from "../app/lib/prisma";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { SystemLogService } from "../app/services/system-log.service";
import { PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE } from "../app/marketplaces/services/stock-deduction.service";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const CSV = has("--csv");
const APPLY = has("--apply");
const TODAS_AS_CONTAS = has("--todas-as-contas");
const SIM_TODAS = has("--sim-todas");
const CONTA_ALVO = val("--conta");
const LIMITE = Number(val("--limite") ?? 200);
const DESDE_FIXO = val("--desde") ? new Date(`${val("--desde")}T00:00:00`) : null;

interface Conta {
  id: string;
  email: string;
  /** false = elegível (a preferência está desligada). */
  reabreAutomaticamente: boolean;
  desde: Date | null;
}

interface Linha {
  email: string;
  userId: string;
  desde: string;
  platform: string;
  listingId: string;
  externalListingId: string;
  sku: string | null;
  produto: string;
  estornoEm: string;
  reason: string;
  productUserId: string;
}

/**
 * Todas as contas DONAS (colaborador herda do pai e nunca governa nada).
 * Traz também as que estão com a preferência LIGADA: o pedido é verificar a
 * base inteira, e uma conta ligada aparecer com zero achados é informação.
 */
async function carregarContas(): Promise<Conta[]> {
  const users = await prisma.user.findMany({
    where: { parentUserId: null },
    // Seleção explícita: a linha de `User` é larga e é lida pelo
    // authMiddleware a cada requisição — não se puxa inteira num script.
    select: { id: true, email: true, reopenListingsOnSaleCancel: true },
    orderBy: { email: "asc" },
  });

  const out: Conta[] = [];
  for (const u of users) {
    let desde: Date | null = DESDE_FIXO;

    if (!desde && !u.reopenListingsOnSaleCancel) {
      // Só quem está desligado precisa de data — para as ligadas a janela não
      // é usada, e a consulta seria desperdício.
      const logs = await prisma.systemLog.findMany({
        where: {
          userId: u.id,
          action: "USER_ACTIVITY",
          details: { path: ["url"], equals: "/users/me/settings" },
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, details: true },
        take: 500,
      });
      const primeiro = logs.find((l) => {
        const body = (l.details as any)?.body;
        return (
          body && typeof body === "object" && "reopenListingsOnSaleCancel" in body
        );
      });
      desde = primeiro ? primeiro.createdAt : null;
    }

    out.push({
      id: u.id,
      email: u.email,
      reabreAutomaticamente: u.reopenListingsOnSaleCancel,
      desde,
    });
  }
  return out;
}

/** Anúncios ainda vendáveis cujo produto voltou por cancelamento. */
async function levantar(conta: Conta): Promise<Linha[]> {
  const restauros = await prisma.stockLog.findMany({
    where: {
      reason: { startsWith: "Estorno venda" },
      previousStock: 0,
      newStock: { gt: 0 },
      ...(conta.desde ? { createdAt: { gt: conta.desde } } : {}),
      product: { userId: conta.id },
    },
    select: {
      productId: true,
      createdAt: true,
      reason: true,
      product: { select: { sku: true, name: true, userId: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (restauros.length === 0) return [];

  // Pré-carga em LOTE — uma consulta para todos os produtos, e não uma por
  // produto dentro do laço (regra de egress da casa).
  const listings = await prisma.productListing.findMany({
    where: {
      productId: { in: [...new Set(restauros.map((r) => r.productId))] },
      status: "active",
      // MESMA restrição do motor: só os canais em que a venda de marketplace
      // REALMENTE tirou o anúncio do ar. Na Shopee e na Magalu ele seguiu
      // publicado com quantidade 0 — despublicá-lo aqui seria uma ação nova,
      // e nenhuma rotina automática a desfaz.
      marketplaceAccount: {
        platform: { in: PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE },
      },
    },
    select: {
      id: true,
      productId: true,
      externalListingId: true,
      marketplaceAccount: { select: { platform: true } },
    },
  });
  const porProduto = new Map<string, typeof listings>();
  for (const l of listings) {
    const lista = porProduto.get(l.productId);
    if (lista) lista.push(l);
    else porProduto.set(l.productId, [l]);
  }

  // Um anúncio pode ter mais de um estorno no período; o primeiro basta.
  const vistos = new Set<string>();
  const linhas: Linha[] = [];
  for (const r of restauros) {
    for (const l of porProduto.get(r.productId) ?? []) {
      if (vistos.has(l.id)) continue;
      vistos.add(l.id);
      linhas.push({
        email: conta.email,
        userId: conta.id,
        desde: conta.desde
          ? conta.desde.toISOString()
          : "(sem registro — desde sempre)",
        platform: l.marketplaceAccount?.platform ?? "?",
        listingId: l.id,
        externalListingId: l.externalListingId,
        sku: r.product?.sku ?? null,
        produto: r.product?.name ?? "",
        estornoEm: r.createdAt.toISOString(),
        reason: r.reason,
        productUserId: r.product?.userId ?? conta.id,
      });
    }
  }
  return linhas;
}

/**
 * Pausa de verdade, pelo motor da aplicação.
 *
 * `userId` vem do PRODUTO e não da conta: `updateListingStatus` valida posse
 * contra `Product.userId`, e existem produtos cujo dono é um colaborador.
 */
async function aplicar(linhas: Linha[]): Promise<{ ok: number; erro: number }> {
  let ok = 0;
  let erro = 0;
  for (const l of linhas.slice(0, LIMITE)) {
    try {
      const r = await ListingUseCase.updateListingStatus(
        l.listingId,
        l.productUserId,
        "paused",
        { forceRemote: true },
      );
      if (r.success) {
        ok++;
        console.log(`    ✓ ${l.platform} ${l.externalListingId}`);
      } else {
        erro++;
        console.log(`    ✗ ${l.platform} ${l.externalListingId} — ${r.error}`);
      }
    } catch (err) {
      erro++;
      console.log(
        `    ✗ ${l.platform} ${l.externalListingId} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Rastro de quem mexeu e no quê. Best-effort: falhar o log não pode desfazer
  // uma pausa que já aconteceu.
  try {
    await SystemLogService.logWarning(
      "REOPEN_OFF_RELISTED_REMEDIATED",
      `Remediação do passivo de reabertura: ${ok} anúncio(s) pausado(s), ${erro} falha(s).`,
      {
        resource: "ProductListing",
        details: {
          aplicados: ok,
          falhas: erro,
          limite: LIMITE,
          contas: [...new Set(linhas.map((l) => l.email))],
          listingIds: linhas.slice(0, LIMITE).map((l) => l.listingId),
        },
      },
    );
  } catch {
    // sem rastro é ruim, sem pausa seria pior — e a pausa já aconteceu.
  }

  return { ok, erro };
}

function imprimirCsv(linhas: Linha[]) {
  const cols = [
    "email",
    "desde",
    "platform",
    "listingId",
    "externalListingId",
    "sku",
    "produto",
    "estornoEm",
    "reason",
  ] as const;
  console.log(cols.join(";"));
  for (const l of linhas) {
    console.log(
      cols.map((c) => String((l as any)[c] ?? "").replace(/;/g, ",")).join(";"),
    );
  }
}

async function run() {
  const contas = await carregarContas();
  const elegiveis = contas.filter((c) => !c.reabreAutomaticamente);
  const alvo = CONTA_ALVO
    ? elegiveis.filter((c) => c.email.toLowerCase() === CONTA_ALVO.toLowerCase())
    : elegiveis;

  if (APPLY && !CONTA_ALVO && !SIM_TODAS) {
    console.error(
      "Recusado: --apply exige alvo explícito. Use --conta <email> ou --sim-todas.",
    );
    process.exitCode = 1;
    return;
  }
  if (CONTA_ALVO && alvo.length === 0) {
    console.error(
      `Recusado: a conta ${CONTA_ALVO} não existe ou está com a reabertura LIGADA (não elegível).`,
    );
    process.exitCode = 1;
    return;
  }

  const linhas: Linha[] = [];
  for (const c of alvo) linhas.push(...(await levantar(c)));

  if (CSV) {
    imprimirCsv(linhas);
    return;
  }

  console.log("");
  console.log(
    "ANÚNCIOS QUE VOLTARAM AO AR APÓS UM CANCELAMENTO, COM A REABERTURA DESLIGADA",
  );
  console.log(
    APPLY ? "MODO: APLICAR (os anúncios abaixo serão pausados)" : "MODO: SIMULAÇÃO — nada será alterado",
  );
  console.log("");

  if (TODAS_AS_CONTAS) {
    const ligadas = contas.filter((c) => c.reabreAutomaticamente);
    console.log(
      `Base completa: ${contas.length} conta(s) — ${elegiveis.length} com a reabertura DESLIGADA, ${ligadas.length} com ela LIGADA.`,
    );
    console.log(
      "Conta com a reabertura LIGADA não entra na lista: nela o anúncio voltar ao ar é o comportamento pedido.",
    );
    console.log("");
  }

  for (const c of alvo) {
    const doTenant = linhas.filter((l) => l.email === c.email);
    console.log(
      `${c.email} — desligou em ${c.desde ? c.desde.toISOString() : "(sem registro)"} — ${doTenant.length} anúncio(s)`,
    );
    const porPlataforma = new Map<string, number>();
    for (const l of doTenant) {
      porPlataforma.set(l.platform, (porPlataforma.get(l.platform) ?? 0) + 1);
    }
    for (const [p, n] of [...porPlataforma].sort()) {
      console.log(`    ${p.padEnd(16)} ${n}`);
    }
    for (const l of doTenant) {
      console.log(
        `    · ${l.platform.padEnd(14)} ${l.externalListingId.padEnd(16)} SKU ${String(l.sku ?? "?").padEnd(10)} estorno ${l.estornoEm}  ${l.produto.slice(0, 44)}`,
      );
    }
    console.log("");
  }

  console.log(`TOTAL: ${linhas.length} anúncio(s) em ${alvo.length} conta(s).`);

  if (!APPLY) {
    console.log("");
    console.log("Nada foi alterado. Para corrigir, confira a lista com o cliente e rode:");
    console.log("  npx tsx scripts/audit-reopen-off-relisted.ts --apply --conta <email>");
    return;
  }

  if (linhas.length > LIMITE) {
    console.log(
      `Teto de ${LIMITE} por execução: os primeiros ${LIMITE} serão pausados; rode de novo para os demais.`,
    );
  }
  console.log("");
  console.log("Pausando...");
  const { ok, erro } = await aplicar(linhas);
  console.log("");
  console.log(`Concluído: ${ok} pausado(s), ${erro} falha(s).`);
}

run()
  .catch((err) => {
    console.error("[audit-reopen-off-relisted] Falhou:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
