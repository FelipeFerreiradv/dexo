/**
 * Corrige o PASSIVO de oversell: anuncio do Mercado Livre que esta fora do ar
 * mas ainda guarda quantidade vendavel de uma peca que nao existe mais.
 *
 * ⚠️ NUNCA chame por `npm run`: o npm engole as flags (inclusive `--apply`) e o
 * script roda em dry-run silencioso — ou pior, sem o filtro de tenant.
 *
 *   tsx scripts/fix-oversell-cross-canal.ts                        # dry-run global
 *   tsx scripts/fix-oversell-cross-canal.ts --email a@b.com        # dry-run do tenant
 *   tsx scripts/fix-oversell-cross-canal.ts --email a@b.com --apply
 *
 * POR QUE ISTO EXISTE
 *
 * O ML PRESERVA `available_quantity` enquanto o anuncio esta fora do ar. Ate
 * 10/09/2026 o sync, ao ver disponivel 0 num anuncio paused/inactive/
 * under_review, apenas registrava um WARNING e retornava SUCESSO. O gate foi
 * corrigido, mas o passivo ja criado nao se conserta sozinho: sao 566 anuncios
 * (14/09/2026) que voltam vendaveis assim que alguem os reativa.
 *
 * O QUE ELE FAZ E O QUE NAO FAZ
 *
 * Escreve UMA coisa: `available_quantity = 0` no anuncio do ML. NAO escreve em
 * `Product` — o estoque local ja esta certo, e e justamente por estar certo que
 * o anuncio esta errado. Nao cria, nao apaga, nao pausa, nao reabre, nao mexe
 * em preco.
 *
 * AS TRAVAS, E DE ONDE ELAS VEM
 *
 * Em 21-22/05/2026 o scripts/balcao-stock-fix.ts gravou 7.236 movimentos de
 * estoque. Em 40 deles o produto tinha MAIS DE UMA unidade e 120 unidades
 * reais sumiram do catalogo de uma vez. A premissa que causou aquilo foi "o
 * anuncio saiu do ar, logo a peca foi vendida". Aqui:
 *
 *  1. PROVA DOCUMENTAL OBRIGATORIA. So age onde existe StockLog negativo (a
 *     peca saiu) ou ReceivableItem em venda aberta (a peca esta comprometida).
 *     Anuncio pausado, sozinho, NAO e prova de nada.
 *  2. A VERDADE E A DO CANAL. Confere o estado ATUAL na API do ML antes de
 *     decidir; o SyncLog serve para achar candidatos, nunca para autorizar a
 *     escrita.
 *  3. DEVOLUCAO PENDENTE BLOQUEIA. Peca que pode voltar ao patio nao e tocada.
 *  4. IDEMPOTENTE. Quantidade remota ja 0 ⇒ nada a fazer. Rodar duas vezes
 *     produz o mesmo resultado.
 *  5. `closed` FICA DE FORA. E terminal, o ML recusa a escrita e o anuncio nao
 *     volta sozinho.
 *  6. ESCOPO POR TENANT sempre resolvido para o dono dos dados
 *     (parentUserId ?? id).
 *  7. NAO FAZ REFRESH DE TOKEN. Usa o accessToken gravado; 401 vira relatorio,
 *     nao renovacao — refresh a partir do ambiente errado marca a conta como
 *     ERROR e o motor para de processar aquele lojista.
 *
 * O QUE ELE NAO CONSEGUE CONSERTAR, E POR QUE
 *
 * O ML RECUSA alterar `available_quantity` em boa parte dos anuncios fora do
 * ar. Medido no SyncLog de producao (60 dias):
 *
 *   inactive      2.922 recusas em 241 anuncios
 *   under_review  1.408 recusas em 557 anuncios
 *   paused           97 recusas em   8 anuncios
 *
 * Na varredura de 14/09/2026, dos 437 alvos: 173 estavam `paused` (devem ser
 * corrigidos), 226 `inactive` e 38 `under_review` (o ML deve recusar). O
 * dry-run imprime essa expectativa em vez de prometer 437 — e o apply separa
 * "recusado pelo ML" de "falha de verdade", para que erro real nao se perca no
 * meio do esperado.
 *
 * Para inactive/under_review nao existe caminho de API. A defesa e detectar a
 * volta para `active` e pausar na hora.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";

const OUT_DIR = join(process.cwd(), "scripts", "out");
const FLAGS_CONHECIDAS = new Set(["apply", "dry-run", "email", "user-id", "dias", "limite"]);

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf("--" + nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function tem(nome: string): boolean {
  return process.argv.includes("--" + nome);
}

// Uma flag com typo (`--aply`) rodaria apply global achando que era dry-run.
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--") && !FLAGS_CONHECIDAS.has(a.slice(2))) {
    console.error("Flag desconhecida: " + a);
    console.error("Conhecidas: " + [...FLAGS_CONHECIDAS].map((f) => "--" + f).join(", "));
    process.exit(2);
  }
}

// --dry-run VENCE --apply, sempre.
const apply = tem("apply") && !tem("dry-run");
const limite = arg("limite") ? Number(arg("limite")) : 1000;
const dias = arg("dias") ? Number(arg("dias")) : 7;

type Candidato = {
  tenant: string;
  userId: string;
  listingId: string;
  externalListingId: string;
  accountId: string;
  accountName: string;
  accessToken: string | null;
  skipReason: string;
  qtdRemotaVista: number;
  productId: string;
  sku: string | null;
  productName: string;
  stock: number;
  reservedStock: number;
  temBaixa: boolean;
  temVendaAberta: boolean;
  temDevolucaoPendente: boolean;
};

async function resolverTenant(): Promise<string | null> {
  const email = arg("email");
  const userId = arg("user-id");
  if (userId) return userId;
  if (!email) return null;
  const u = await prisma.user.findUnique({
    where: { email },
    select: { id: true, parentUserId: true },
  });
  if (!u) throw new Error("Usuario nao encontrado: " + email);
  return u.parentUserId ?? u.id;
}

async function coletarCandidatos(tenant: string | null): Promise<Candidato[]> {
  return prisma.$queryRawUnsafe<Candidato[]>(
    `
    WITH ultimo AS (
      SELECT DISTINCT ON (sl.payload->>'externalListingId')
             sl.payload->>'externalListingId' AS item,
             sl.payload->>'skipReason' AS skip,
             (sl.payload->>'remoteAvailableQuantity')::int AS qtd
      FROM "SyncLog" sl
      WHERE sl.type = 'STOCK_UPDATE'
        AND sl.payload->>'skipReason' IS NOT NULL
        AND sl."createdAt" > now() - ($1 || ' days')::interval
      ORDER BY sl.payload->>'externalListingId', sl."createdAt" DESC
    )
    SELECT u.email                       AS tenant,
           p."userId"                    AS "userId",
           pl.id                         AS "listingId",
           pl."externalListingId"        AS "externalListingId",
           ma.id                         AS "accountId",
           ma."accountName"              AS "accountName",
           ma."accessToken"              AS "accessToken",
           ultimo.skip                   AS "skipReason",
           ultimo.qtd                    AS "qtdRemotaVista",
           p.id                          AS "productId",
           p.sku                         AS sku,
           p.name                        AS "productName",
           p.stock                       AS stock,
           p."reservedStock"             AS "reservedStock",
           EXISTS (SELECT 1 FROM "StockLog" sl2
                   WHERE sl2."productId" = p.id AND sl2.change < 0) AS "temBaixa",
           EXISTS (SELECT 1 FROM "ReceivableItem" ri
                   JOIN "Receivable" r ON r.id = ri."receivableId"
                   WHERE ri."productId" = p.id
                     AND r.status IN ('PENDENTE','VENCIDA'))        AS "temVendaAberta",
           EXISTS (SELECT 1 FROM "OrderReturnPendency" orp
                   JOIN "Order" o2 ON o2."externalOrderId" = orp."externalOrderId"
                                  AND o2."marketplaceAccountId" = orp."marketplaceAccountId"
                   JOIN "OrderItem" oi2 ON oi2."orderId" = o2.id
                   WHERE oi2."productId" = p.id
                     AND orp.status <> 'RESOLVED')                  AS "temDevolucaoPendente"
    FROM ultimo
    JOIN "ProductListing" pl ON pl."externalListingId" = ultimo.item
    JOIN "Product" p         ON p.id = pl."productId"
    JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
    JOIN "User" u            ON u.id = ma."userId"
    WHERE ultimo.qtd > 0
      AND ultimo.skip <> 'ml_status_closed'
      AND ma.platform = 'MERCADO_LIVRE'
      AND ma.status = 'ACTIVE'
      AND (p.stock - p."reservedStock") <= 0
      AND ($2::text IS NULL OR p."userId" = $2::text)
    ORDER BY u.email, p.sku
    LIMIT ${Math.max(1, Math.min(limite, 5000))}
  `,
    String(dias),
    tenant,
  );
}

type Decisao = {
  acao: "ZERAR" | "PULAR";
  motivo: string;
  qtdRemotaAgora?: number;
  statusRemoto?: string;
};

/**
 * Pre-carga em LOTE do estado no ML, por conta, em blocos de 20 com selecao
 * explicita de campos. Uma consulta por candidato custaria 555 chamadas e
 * ~6,8 MB; assim sao ~28 chamadas e ~85 KB. E a regra de egress da casa:
 * pre-carga em lote no lugar de consulta repetida dentro de laco.
 *
 * Conta cujo multiget falha fica com o mapa vazio, e todo candidato dela cai
 * em PULAR com o motivo registrado — nunca em escrita as cegas.
 */
async function carregarSnapshots(
  candidatos: Candidato[],
): Promise<Map<string, { status: string; available_quantity: number }>> {
  const mapa = new Map<string, { status: string; available_quantity: number }>();
  const porConta = new Map<string, Candidato[]>();
  for (const c of candidatos) {
    if (!c.accessToken) continue;
    const atual = porConta.get(c.accountId) ?? [];
    atual.push(c);
    porConta.set(c.accountId, atual);
  }

  for (const [, lista] of porConta) {
    try {
      const snap = await MLApiService.getItemsStockSnapshot(
        lista[0].accessToken!,
        lista.map((c) => c.externalListingId),
      );
      for (const s of snap) {
        mapa.set(s.id, {
          status: s.status,
          available_quantity: s.available_quantity,
        });
      }
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      console.error(
        "  ! multiget falhou para a conta " +
          lista[0].accountName +
          (status ? " (HTTP " + status + ")" : "") +
          " — " +
          lista.length +
          " anuncio(s) ficam sem leitura e serao PULADOS",
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return mapa;
}

/** A verdade e a do canal: o SyncLog acha o candidato, a API do ML decide. */
function decidir(
  c: Candidato,
  snapshot: Map<string, { status: string; available_quantity: number }>,
): Decisao {
  if (c.temDevolucaoPendente) {
    return { acao: "PULAR", motivo: "devolucao pendente — a peca pode voltar ao patio" };
  }
  if (!c.temBaixa && !c.temVendaAberta) {
    return {
      acao: "PULAR",
      motivo: "sem prova documental de consumo (nenhum StockLog negativo, nenhuma venda aberta)",
    };
  }
  if (!c.accessToken) {
    return { acao: "PULAR", motivo: "conta sem accessToken" };
  }

  const item = snapshot.get(c.externalListingId);
  if (!item) {
    return {
      acao: "PULAR",
      motivo:
        "sem leitura do ML (multiget falhou, token expirado ou item inacessivel) — NAO escrevemos as cegas",
    };
  }

  const qtd = Number(item.available_quantity ?? 0);
  const st = String(item.status ?? "");

  if (st === "closed") {
    return { acao: "PULAR", motivo: "ja esta closed no ML", qtdRemotaAgora: qtd, statusRemoto: st };
  }
  if (qtd <= 0) {
    return {
      acao: "PULAR",
      motivo: "quantidade remota ja e 0 (idempotencia)",
      qtdRemotaAgora: qtd,
      statusRemoto: st,
    };
  }
  if (st === "active") {
    // O anuncio VOLTOU ao ar sozinho e esta vendendo agora. Zerar a quantidade
    // e ainda mais urgente, mas nao e este script que decide pausar — o sync
    // corrigido faz isso no proximo tick.
    return {
      acao: "ZERAR",
      motivo: "ATIVO no ML com peca inexistente — oversell iminente",
      qtdRemotaAgora: qtd,
      statusRemoto: st,
    };
  }
  return {
    acao: "ZERAR",
    motivo: "fora do ar (" + st + ") guardando quantidade vendavel",
    qtdRemotaAgora: qtd,
    statusRemoto: st,
  };
}

async function main() {
  const tenant = await resolverTenant();

  console.log("");
  console.log("  fix-oversell-cross-canal — " + (apply ? "APPLY" : "DRY-RUN"));
  console.log("  escopo: " + (tenant ?? "TODOS os tenants") + " · janela " + dias + "d · limite " + limite);
  console.log("");

  const candidatos = await coletarCandidatos(tenant);
  console.log("  candidatos: " + candidatos.length);
  if (candidatos.length === 0) {
    console.log("  nada a fazer.");
    return;
  }

  // Multi-unidade tem tratamento explicito e nomeado: aqui o disponivel e 0,
  // mas o estoque BRUTO pode ser > 0 (peca fisica existe, esta comprometida em
  // venda aberta). Zerar o anuncio continua correto — a peca ja tem dono — mas
  // quem roda precisa ver isso destacado antes de autorizar.
  const porReserva = candidatos.filter((c) => c.stock > 0);
  if (porReserva.length > 0) {
    console.log("");
    console.log("  ⚠ " + porReserva.length + " anuncio(s) cujo disponivel e 0 por RESERVA (a peca fisica existe):");
    for (const c of porReserva.slice(0, 40)) {
      console.log(
        "    - " + c.tenant + " · SKU " + (c.sku ?? "—") + " · estoque " + c.stock +
          " − reserva " + c.reservedStock + " · " + c.externalListingId,
      );
    }
    if (porReserva.length > 40) console.log("    ... e mais " + (porReserva.length - 40));
  }

  console.log("");
  console.log("  lendo o estado atual no ML (multiget por conta)...");
  const snapshot = await carregarSnapshots(candidatos);
  console.log("  lidos: " + snapshot.size + " / " + candidatos.length);

  const decisoes: Array<{
    c: Candidato;
    d: Decisao;
    aplicado?: boolean;
    erro?: string;
    recusadoPeloML?: boolean;
  }> = [];
  for (const c of candidatos) {
    decisoes.push({ c, d: decidir(c, snapshot) });
  }

  const aZerar = decisoes.filter((x) => x.d.acao === "ZERAR");
  const pulados = decisoes.filter((x) => x.d.acao === "PULAR");

  console.log("");
  console.log("  ── DECISAO ──────────────────────────────────────────────");
  console.log("  a ZERAR : " + aZerar.length);
  console.log("  PULADOS : " + pulados.length);
  const porMotivo = new Map<string, number>();
  for (const p of pulados) porMotivo.set(p.d.motivo, (porMotivo.get(p.d.motivo) ?? 0) + 1);
  for (const [m, n] of [...porMotivo.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("            · " + n + " — " + m);
  }

  const unidades = aZerar.reduce((s, x) => s + (x.d.qtdRemotaAgora ?? 0), 0);
  console.log("");
  console.log("  UNIDADES FANTASMA ALVO: " + unidades);

  // EXPECTATIVA REALISTA, e nao promessa. O ML recusa alterar
  // `available_quantity` em boa parte dos anuncios fora do ar — medido no
  // SyncLog de producao (60 dias): 2.922 recusas em 241 anuncios `inactive`,
  // 1.408 em 557 `under_review`, 97 em 8 `paused`. Prometer que 437 serao
  // corrigidos seria mentira; o numero que importa e este aqui embaixo.
  const porStatus = new Map<string, number>();
  for (const x of aZerar) {
    const st = x.d.statusRemoto ?? "?";
    porStatus.set(st, (porStatus.get(st) ?? 0) + 1);
  }
  const provavelOk = porStatus.get("paused") ?? 0;
  const provavelRecusa =
    (porStatus.get("inactive") ?? 0) + (porStatus.get("under_review") ?? 0);
  console.log("");
  console.log("  EXPECTATIVA (o ML recusa quantidade em anuncio fora do ar):");
  for (const [st, n] of [...porStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("    · " + st + ": " + n);
  }
  console.log("    → provavel SUCESSO (paused): " + provavelOk);
  console.log(
    "    → provavel RECUSA do ML (inactive/under_review): " + provavelRecusa,
  );
  console.log(
    "      Para esses nao existe caminho de API: a defesa e detectar a volta",
  );
  console.log("      para `active` e pausar na hora.");
  const ativos = aZerar.filter((x) => x.d.statusRemoto === "active");
  if (ativos.length > 0) {
    console.log("  🔴 " + ativos.length + " deles estao ATIVOS no ML AGORA (venda iminente):");
    for (const x of ativos.slice(0, 30)) {
      console.log("     - " + x.c.tenant + " · SKU " + (x.c.sku ?? "—") + " · " + x.c.externalListingId);
    }
  }

  if (!apply) {
    console.log("");
    console.log("  DRY-RUN — nenhuma escrita foi feita.");
    console.log("  Para aplicar: --apply (e, de preferencia, com --email de um tenant por vez).");
  } else {
    console.log("");
    console.log("  APLICANDO...");
    for (const x of aZerar) {
      try {
        await MLApiService.updateItemStock(x.c.accessToken!, x.c.externalListingId, 0);
        x.aplicado = true;
        // Rastro no mesmo lugar em que o sync escreve, para a auditoria seguinte
        // enxergar o que foi feito por aqui.
        await prisma.syncLog.create({
          data: {
            marketplaceAccountId: x.c.accountId,
            type: "STOCK_UPDATE",
            status: "SUCCESS",
            message:
              "Anuncio " + x.c.externalListingId + " estava " + x.d.statusRemoto +
              " com quantidade remota=" + x.d.qtdRemotaAgora +
              " e disponivel local 0. Quantidade zerada por fix-oversell-cross-canal.",
            payload: {
              productId: x.c.productId,
              externalListingId: x.c.externalListingId,
              previousStock: x.d.qtdRemotaAgora ?? null,
              newStock: 0,
              remoteStatus: x.d.statusRemoto ?? null,
              reason: "fix_oversell_cross_canal",
            },
          },
        });
        console.log("    ✓ " + x.c.externalListingId + " (SKU " + (x.c.sku ?? "—") + ")");
      } catch (err: any) {
        x.erro = err?.message ?? String(err);
        // A recusa do ML e um NAO definitivo, nao um defeito nosso: separamos
        // para nao afogar erro de verdade no relatorio.
        const m = String(x.erro).toLowerCase();
        x.recusadoPeloML =
          (m.includes("available_quantity") &&
            (m.includes("not_modifiable") ||
              m.includes("not modifiable") ||
              m.includes("not_updatable") ||
              m.includes("not updatable"))) ||
          // Terceira forma, vista so na primeira execucao real: o ML recusa o
          // VALOR zero neste anuncio. Mesma natureza — um nao definitivo.
          m.includes("item.stock.invalid") ||
          m.includes("stock of item should be more than");
        if (x.recusadoPeloML) {
          console.log("    – " + x.c.externalListingId + ": ML recusou (esperado)");
        } else {
          console.error("    ✗ " + x.c.externalListingId + ": " + x.erro);
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const ok = aZerar.filter((x) => x.aplicado).length;
    const recusados = aZerar.filter((x) => x.recusadoPeloML).length;
    const falhos = aZerar.filter((x) => x.erro && !x.recusadoPeloML).length;
    console.log("");
    console.log("  corrigidos          : " + ok + " / " + aZerar.length);
    console.log("  recusados pelo ML   : " + recusados);
    console.log("  falhas de verdade   : " + falhos);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const base = join(OUT_DIR, "fix-oversell-cross-canal" + (apply ? "-apply" : "-dryrun"));
  writeFileSync(
    base + ".json",
    JSON.stringify(
      {
        geradoEm: new Date().toISOString(),
        modo: apply ? "APPLY" : "DRY-RUN",
        escopo: tenant ?? "TODOS",
        janelaDias: dias,
        resumo: {
          candidatos: candidatos.length,
          aZerar: aZerar.length,
          pulados: pulados.length,
          unidades,
          ativosNoML: ativos.length,
          disponivelZeroPorReserva: porReserva.length,
          aplicados: apply ? aZerar.filter((x) => x.aplicado).length : 0,
          recusadosPeloML: apply
            ? aZerar.filter((x) => x.recusadoPeloML).length
            : 0,
          expectativaSucesso: aZerar.filter(
            (x) => x.d.statusRemoto === "paused",
          ).length,
          expectativaRecusa: aZerar.filter(
            (x) =>
              x.d.statusRemoto === "inactive" ||
              x.d.statusRemoto === "under_review",
          ).length,
        },
        itens: decisoes.map((x) => ({
          tenant: x.c.tenant,
          sku: x.c.sku,
          productId: x.c.productId,
          externalListingId: x.c.externalListingId,
          conta: x.c.accountName,
          stockLocal: x.c.stock,
          reservedStock: x.c.reservedStock,
          statusRemoto: x.d.statusRemoto ?? null,
          qtdRemotaAgora: x.d.qtdRemotaAgora ?? null,
          acao: x.d.acao,
          motivo: x.d.motivo,
          aplicado: x.aplicado ?? false,
          erro: x.erro ?? null,
          recusadoPeloML: x.recusadoPeloML ?? false,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("");
  console.log("  Relatorio: " + base + ".json");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
