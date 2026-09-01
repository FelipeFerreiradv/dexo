/**
 * audit-estoque-fantasma-devolucao.ts
 *
 * Varre TODOS os tenants e encontra as peças cujo estoque VOLTOU por um
 * estorno de cancelamento que, na verdade, era uma DEVOLUÇÃO — a peça saiu do
 * pátio e não voltou, mas o sistema recriou a unidade e reabriu o anúncio.
 * É o passivo do período em que `processOrderCancellation` tratava
 * "cancelado antes do envio" e "devolvido depois da entrega" como a mesma
 * coisa, porque o ML usa `status: "cancelled"` para os dois.
 *
 * PADRÃO: DRY-RUN. Sem `--apply` nada é escrito, nem no banco nem em
 * marketplace nenhum — nem sequer um refresh de token (ver decisão 4).
 *
 * ── COMO ELE DECIDE (e por que assim) ─────────────────────────────────────
 *
 *  1. QUAIS peças voltaram por cancelamento. `StockLog` com `reason`
 *     começando em "Estorno venda ML #", `previousStock = 0` e
 *     `newStock > 0` — exatamente o filtro que o motor usa para decidir
 *     reabrir (`stock-deduction.service.ts`: `previousStock === 0 &&
 *     newStock > 0`). Restauração que não saiu de zero nunca teve anúncio
 *     pausado por falta de peça, e por isso não entra.
 *
 *  2. QUAIS desses estornos estavam ERRADOS. Aqui está a diferença deste
 *     script para todos os outros da pasta: ELE CHAMA A API DO MERCADO LIVRE.
 *     `GET /orders/{id}` + `GET /shipments/{id}`, classificados pelo mesmo
 *     `OrderOutcomeService` que o webhook usa em produção — a mesma regra
 *     decidindo o passado e o futuro.
 *
 *     Por que não dá para decidir só pelo banco: testamos o atalho óbvio
 *     ("estorno tardio = devolução") e ele é FALSO nos dois sentidos. O
 *     pedido 2000017407259734 é `buyer_cancel_express` 7,2 DIAS depois da
 *     venda (envio cancelado, peça no pátio, estorno CORRETO) e o
 *     2000017872842612 é `mediations` com 1,08 dia (peça fora, estorno
 *     ERRADO). As caudas se cruzam. Sem o payload, a lista erraria nos dois
 *     sentidos — e errar para o lado de "sumir com peça boa" é pior que o
 *     bug original.
 *
 *  3. QUANTO tirar. O líquido do `StockLog` entre a reason do estorno e a
 *     deste script, com teto no estoque atual. Peça que já foi vendida de
 *     novo depois do estorno tem estoque 0 e sai da lista sozinha — não há o
 *     que remediar, o estrago já aconteceu.
 *
 *  3b. QUANDO NÃO TIRAR NADA, e esta é a assimetria que importa. Se o próprio
 *     ML registrou a devolução como CONCLUÍDA (`date_returned` preenchido), a
 *     peça provavelmente ESTÁ no pátio: o estorno que a devolveu ao estoque
 *     acertou por sorte. Zerar aí não corrigiria um estoque fantasma —
 *     destruiria estoque real, que é exatamente o furo oposto.
 *
 *     Repare que a regra prospectiva é a outra: no cancelamento, RETER é de
 *     graça (o estoque já estava em 0 e ninguém perde nada esperando um
 *     clique). Aqui, remover CUSTA. Por isso esses casos entram no relatório e
 *     no `--apply` apenas como PERGUNTA — pendência aberta, estoque intocado.
 *
 *  4. QUANDO ele desiste de classificar. Token da conta expirado em modo
 *     dry-run: a conta inteira é PULADA e sai marcada como
 *     `(nao classificado)`. Renovar token é ESCRITA no banco, e "dry-run" que
 *     escreve não é dry-run. No `--apply` a renovação é permitida.
 *
 * ── ⚠️ O QUE ESTA LISTA NÃO PROVA ────────────────────────────────────────
 *
 *  - Que a peça não esteja fisicamente no pátio. O ML diz onde a peça estava
 *    quando ELE fechou o pedido. Se a devolução chegou depois e o lojista
 *    guardou a peça sem registrar, a linha é falso positivo — e por isso o
 *    `--apply` abre uma PENDÊNCIA em vez de encerrar o assunto: o operador
 *    ainda pode dizer "recebi" e o estoque volta pelo caminho normal.
 *  - Que o anúncio no ar seja indevido. O lojista pode tê-lo reativado de
 *    propósito, com peça de outro lote.
 *  - Nada sobre as peças marcadas `DEVOLVIDA_CONFIRMADA` além de "vale
 *    conferir": nelas o script NUNCA mexe em estoque (ver decisão 3b).
 *  - Nada sobre Shopee, Magalu, OLX ou Facebook. Só o ML tem pós-venda legível
 *    hoje; as outras plataformas não entram na varredura e não são contadas.
 *  - Nada sobre contas cujo token expirou em dry-run (ver decisão 4). Elas
 *    aparecem no relatório como não classificadas — silenciar o corte é o que
 *    o invariante proíbe.
 *
 * ── COMO ESCREVE, quando escreve ─────────────────────────────────────────
 *
 * Três escritas, nesta ordem, e todas reversíveis:
 *  a) `StockLog` com reason PRÓPRIA ("Baixa de devolução não recebida ML #id")
 *     e o `Product.stock` ajustado, na mesma transação e com `FOR UPDATE` —
 *     nunca reusa "Estorno venda ...", que envenenaria o net do cancelamento;
 *  b) pausa dos anúncios em TODOS os canais pelo motor da aplicação
 *     (`ProductUseCase.pauseListings`, com `forceRemote`), nunca por chamada
 *     solta a marketplace — assim herda kill-switches, posse e espelho local;
 *  c) pendência de devolução aberta com o motivo, para o operador ainda poder
 *     dizer "a peça voltou" e o estoque voltar pelo caminho normal.
 * Mais `SystemLog` `RETURN_PHANTOM_STOCK_REMEDIATED` por peça.
 *
 * ── COMO ELE PRESTA CONTAS ───────────────────────────────────────────────
 *
 * `ProductUseCase.pauseListings` devolve `success: true` em sucesso PARCIAL —
 * se o script acreditasse nele, imprimiria "0 falhas" com anúncio no ar, que é
 * exatamente o estado que esta varredura existe para eliminar. Então ele não
 * acredita: depois de pausar, RELÊ o banco e conta quantos anúncios daquela
 * peça continuam `active`.
 *
 * São duas listas, e elas têm pesos diferentes:
 *  - "anúncios que o motor não pausou": informativo. Recusa por item já
 *    `closed` no ML ou já apagado na Shopee é INOFENSIVA — está mais fora do
 *    ar que pausado.
 *  - "anúncios ainda ATIVOS com a peça zerada": é falha de verdade, sai em
 *    vermelho e leva o exit code a 2 mesmo que todas as peças tenham sido
 *    zeradas. Peça comprável que a loja não tem é o bug, não o sucesso.
 *
 * Idempotente: peça que já tem a baixa deste script sai da lista.
 *
 * Uso:
 *   # 1) Panorama de TODOS os tenants (nada é alterado)
 *   npx tsx scripts/audit-estoque-fantasma-devolucao.ts
 *
 *   # 2) Um tenant só
 *   npx tsx scripts/audit-estoque-fantasma-devolucao.ts --conta cliente@exemplo.com
 *
 *   # 3) Planilha para conferir com o cliente
 *   npx tsx scripts/audit-estoque-fantasma-devolucao.ts --csv > passivo.csv
 *
 *   # 4) Corrigir UM tenant, depois de conferido
 *   npx tsx scripts/audit-estoque-fantasma-devolucao.ts --apply --conta cliente@exemplo.com
 *
 *   # 5) Corrigir todos (exige o confirmador explícito)
 *   npx tsx scripts/audit-estoque-fantasma-devolucao.ts --apply --sim-todas
 *
 * Flags extras:
 *   --limite N     teto de peças alteradas nesta execução (padrão 200)
 *   --desde DATA   só estornos a partir desta data (YYYY-MM-DD)
 *   --sem-relatorio  não grava o .md em audit-reports/
 *   --teto-api N   teto de chamadas ao ML nesta execução (padrão 6000). Ao
 *                  atingir, PARA e marca o relatório como TRUNCADO — nunca
 *                  entrega lista curta com cara de lista completa.
 *
 * Exit codes (padrão de scripts/prod-audit/run-all.ts):
 *   0 — nenhuma peça com estoque fantasma
 *   1 — encontrou peças (há passivo)
 *   2 — o script falhou
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { OrderOutcomeService } from "../app/marketplaces/services/order-outcome.service";
import { OrderReturnPendencyService } from "../app/marketplaces/services/order-return-pendency.service";
import { ProductUseCase } from "../app/usecases/product.usercase";
import { SystemLogService } from "../app/services/system-log.service";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CSV = has("--csv");
const APPLY = has("--apply");
const SIM_TODAS = has("--sim-todas");
const SEM_RELATORIO = has("--sem-relatorio");
const CONTA_ALVO = val("--conta");
const LIMITE = Number(val("--limite") ?? 200);
const DESDE = val("--desde") ? new Date(`${val("--desde")}T00:00:00`) : null;

interface Tenant {
  id: string;
  email: string;
}

interface Linha {
  email: string;
  tenantId: string;
  /**
   * A conta que de fato respondeu pelo pedido na API. Guardada aqui de
   * propósito: sem ela, `abrirPendencia` teria de reencontrar o Order por
   * `externalOrderId` sozinho — o que (a) não usa o índice
   * `(marketplaceAccountId, externalOrderId)` como seek, e sim varre o índice
   * inteiro (medido em produção: 59 buffers, 25 ms por peça), e (b) poderia
   * casar com o pedido de OUTRO tenant. Carregar o id elimina a consulta e o
   * risco de uma vez.
   */
  marketplaceAccountId: string;
  productId: string;
  sku: string;
  produto: string;
  externalOrderId: string;
  estornoEm: string;
  estoqueAtual: number;
  anunciosAtivos: number;
  cancelGroup: string;
  shipmentStatus: string;
  desfecho: string;
  aRemover: number;
  /**
   * `ZERAR_E_PAUSAR` — a peça está com o comprador ou extraviada: o estoque é
   * fantasma e sai. `SO_PERGUNTAR` — o ML diz que a devolução chegou: o
   * estoque provavelmente é REAL, então nada é removido e só abrimos a
   * pergunta. Ver a decisão 3b no cabeçalho.
   */
  acao: "ZERAR_E_PAUSAR" | "SO_PERGUNTAR";
}

/** Contas que não deu para classificar — vão para o relatório, não somem. */
const naoClassificadas: Array<{ email: string; conta: string; motivo: string }> =
  [];

/**
 * Peças que NENHUMA conta conseguiu classificar. Existe porque o `catch` do
 * laço engolia qualquer erro: sob rate-limit ou 5xx do ML, a peça saía da
 * lista e o relatório imprimia "TOTAL: 0" com cara de resultado limpo. Isso
 * violaria o invariante que o próprio cabeçalho declara — silenciar o corte é
 * o que ele proíbe. 403/404 são ESPERADOS (o pedido é de outra conta do mesmo
 * tenant) e por isso não entram aqui quando outra conta classifica a peça.
 */
const naoClassificadas_pecas: Array<{
  email: string;
  sku: string;
  externalOrderId: string;
  motivo: string;
}> = [];

/**
 * Anúncios que o motor NÃO conseguiu pausar. Nem toda falha aqui é perigo — a
 * Shopee recusa desalistar o que ela já apagou, e o ML recusa pausar item já
 * `closed`, que é MAIS fora do ar que pausado. Serve para o operador ver.
 */
const anunciosComFalha: Array<{
  email: string;
  sku: string;
  externalListingId: string;
  platform: string;
  erro: string;
}> = [];

/**
 * ⚠️ A lista que importa: anúncios que continuam `active` DEPOIS da pausa, com
 * a peça em estoque 0. É peça comprável que a loja não tem — o próprio estado
 * que esta varredura existe para eliminar. Se esta lista não estiver vazia, a
 * execução NÃO foi um sucesso, por mais que as peças tenham sido zeradas.
 */
const anunciosAindaVendaveis: Array<{
  email: string;
  sku: string;
  externalListingId: string;
  platform: string;
}> = [];

/** Teto de chamadas à API do ML por execução (regra de egress nº 7). */
const TETO_API = Number(val("--teto-api") ?? 6000);
let chamadasApi = 0;
let truncadoPorTeto = false;

async function carregarTenants(): Promise<Tenant[]> {
  // Seleção explícita: a linha de `User` é larga e é lida pelo authMiddleware
  // a cada requisição — não se puxa inteira num script.
  const users = await prisma.user.findMany({
    where: { parentUserId: null },
    select: { id: true, email: true },
    orderBy: { email: "asc" },
  });
  return users;
}

/**
 * Token utilizável da conta. Em dry-run NUNCA renova (renovar é escrita, e
 * dry-run que escreve não é dry-run) — devolve null e a conta sai do escopo.
 */
async function tokenDaConta(
  accountId: string,
): Promise<{ token: string } | { erro: string }> {
  const acc = await prisma.marketplaceAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
    },
  });
  if (!acc) return { erro: "conta não encontrada" };
  if (!acc.expiresAt || acc.expiresAt > new Date()) {
    return { token: acc.accessToken };
  }
  if (!APPLY) {
    return { erro: "token expirado (dry-run não renova — seria escrita)" };
  }
  if (!acc.refreshToken) return { erro: "token expirado e sem refresh token" };
  // A renovação NÃO pode derrubar a varredura. Uma conta conectada sob outra
  // aplicação do ML devolve `client_id_mismatch`, e sem esta guarda o erro
  // sobe até o catch final e mata os outros 33 tenants no meio do caminho —
  // aconteceu em 01/09/2026. Conta que não renova vira "não classificada",
  // igual ao dry-run, e o laço segue.
  try {
    const r = await MLOAuthService.refreshAccessToken(acc.refreshToken);
    await MarketplaceRepository.updateTokens(acc.id, {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: new Date(Date.now() + r.expiresIn * 1000),
    });
    return { token: r.accessToken };
  } catch (err) {
    // Só a MENSAGEM: o objeto de erro do axios carrega o corpo da requisição,
    // e o corpo do refresh tem `client_secret` e `refresh_token`.
    return {
      erro: `falha ao renovar token: ${err instanceof Error ? err.message : "erro desconhecido"}`,
    };
  }
}

async function levantar(t: Tenant): Promise<Linha[]> {
  // Só contas ACTIVE: uma conta em ERROR já falhou a renovação antes e não vai
  // responder agora. Tentar é queimar chamada e arriscar derrubar o laço.
  const contas = await prisma.marketplaceAccount.findMany({
    where: { userId: t.id, platform: "MERCADO_LIVRE", status: "ACTIVE" },
    select: { id: true, accountName: true },
  });
  const inativas = await prisma.marketplaceAccount.count({
    where: { userId: t.id, platform: "MERCADO_LIVRE", status: { not: "ACTIVE" } },
  });
  if (inativas > 0) {
    naoClassificadas.push({
      email: t.email,
      conta: `${inativas} conta(s) ML`,
      motivo: "conta com status diferente de ACTIVE — reconecte antes de varrer",
    });
  }
  if (contas.length === 0) return [];

  const estornos = await prisma.stockLog.findMany({
    where: {
      reason: { startsWith: "Estorno venda ML #" },
      previousStock: 0,
      newStock: { gt: 0 },
      ...(DESDE ? { createdAt: { gte: DESDE } } : {}),
      product: { userId: t.id },
    },
    select: {
      productId: true,
      reason: true,
      createdAt: true,
      product: { select: { sku: true, name: true, stock: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (estornos.length === 0) return [];

  // Pré-carga em LOTE — uma consulta para todos os produtos, e não uma por
  // produto dentro do laço (regra de egress da casa).
  const productIds = [...new Set(estornos.map((e) => e.productId))];
  const listings = await prisma.productListing.findMany({
    where: { productId: { in: productIds }, status: "active" },
    select: { productId: true },
  });
  const ativosPorProduto = new Map<string, number>();
  for (const l of listings) {
    ativosPorProduto.set(
      l.productId,
      (ativosPorProduto.get(l.productId) ?? 0) + 1,
    );
  }

  // O líquido por (produto, pedido) já considerando baixas anteriores deste
  // mesmo script — é o que torna a execução idempotente.
  const reasons = [
    ...new Set(
      estornos.flatMap((e) => [
        e.reason,
        e.reason.replace(
          "Estorno venda ML #",
          "Baixa de devolução não recebida ML #",
        ),
      ]),
    ),
  ];
  const liquidos = await prisma.stockLog.groupBy({
    by: ["productId", "reason"],
    where: { productId: { in: productIds }, reason: { in: reasons } },
    _sum: { change: true },
  });
  const somaPorChave = new Map<string, number>();
  for (const g of liquidos) {
    const extId = g.reason.replace(/^[^#]*#/, "");
    const chave = `${g.productId}::${extId}`;
    somaPorChave.set(chave, (somaPorChave.get(chave) ?? 0) + (g._sum.change ?? 0));
  }

  const linhas: Linha[] = [];
  const vistos = new Set<string>();
  /** chave → último erro da API. Esvaziado quando alguma conta classifica. */
  const falhaPorChave = new Map<string, string>();
  const skuPorChave = new Map<string, string>();
  for (const e of estornos) {
    skuPorChave.set(
      `${e.productId}::${e.reason.replace("Estorno venda ML #", "")}`,
      e.product.sku,
    );
  }

  for (const conta of contas) {
    const tok = await tokenDaConta(conta.id);
    if ("erro" in tok) {
      naoClassificadas.push({
        email: t.email,
        conta: conta.accountName ?? conta.id,
        motivo: tok.erro,
      });
      continue;
    }

    for (const e of estornos) {
      const extId = e.reason.replace("Estorno venda ML #", "");
      const chave = `${e.productId}::${extId}`;
      if (vistos.has(chave)) continue;

      const liquido = somaPorChave.get(chave) ?? 0;
      // Já remediado (líquido 0) ou peça já consumida de novo (estoque 0).
      const aRemover = Math.min(Math.max(0, liquido), e.product.stock);
      if (aRemover === 0) continue;

      if (chamadasApi >= TETO_API) {
        truncadoPorTeto = true;
        break;
      }

      let mlOrder;
      try {
        chamadasApi++;
        mlOrder = await MLApiService.getOrderDetails(tok.token, extId);
      } catch (err) {
        // 403/404 é ESPERADO: o pedido é de outra conta do mesmo tenant. A
        // próxima conta do laço tenta. Mas o erro fica REGISTRADO por chave —
        // se nenhuma conta classificar a peça, ela sai no relatório como não
        // classificada, e não some em silêncio.
        falhaPorChave.set(chave, err instanceof Error ? err.message : String(err));
        continue;
      }
      vistos.add(chave);
      falhaPorChave.delete(chave);

      const shipmentId = mlOrder.shipping?.id ?? null;
      let shipment = null;
      if (shipmentId) {
        chamadasApi++;
        shipment = await MLApiService.getShipmentDetails(tok.token, shipmentId);
      }
      const desfecho = OrderOutcomeService.classificarML(mlOrder, shipment);
      if (!desfecho.reterEstorno) continue; // estorno estava CORRETO

      linhas.push({
        email: t.email,
        tenantId: t.id,
        marketplaceAccountId: conta.id,
        productId: e.productId,
        sku: e.product.sku,
        produto: e.product.name,
        externalOrderId: extId,
        estornoEm: e.createdAt.toISOString(),
        estoqueAtual: e.product.stock,
        anunciosAtivos: ativosPorProduto.get(e.productId) ?? 0,
        cancelGroup: String(desfecho.evidencia.cancelGroup ?? ""),
        shipmentStatus: String(desfecho.evidencia.shipmentStatus ?? ""),
        desfecho: desfecho.peca,
        aRemover: desfecho.peca === "DEVOLVIDA_CONFIRMADA" ? 0 : aRemover,
        acao:
          desfecho.peca === "DEVOLVIDA_CONFIRMADA"
            ? "SO_PERGUNTAR"
            : "ZERAR_E_PAUSAR",
      });
    }
  }

  for (const [chave, motivo] of falhaPorChave) {
    naoClassificadas_pecas.push({
      email: t.email,
      sku: skuPorChave.get(chave) ?? chave.split("::")[0],
      externalOrderId: chave.split("::")[1] ?? "",
      motivo,
    });
  }

  return linhas;
}

/** Abre a pendência para o operador decidir. Usada nos dois ramos do apply. */
async function abrirPendencia(l: Linha, removido: number): Promise<void> {
  await OrderReturnPendencyService.open({
    marketplaceAccountId: l.marketplaceAccountId,
    platform: "MERCADO_LIVRE",
    externalOrderId: l.externalOrderId,
    reason:
      l.desfecho === "COM_COMPRADOR"
        ? "PECA_COM_COMPRADOR"
        : l.desfecho === "DEVOLVIDA_CONFIRMADA"
          ? "DEVOLVIDA_CONFIRMADA_ML"
          : "PECA_EM_TRANSITO",
    detail:
      removido > 0
        ? `Estoque fantasma removido pela varredura (${l.desfecho}). Se a peça voltou ao pátio, confirme o recebimento e o estoque volta.`
        : `O Mercado Livre registrou esta devolução como concluída. O estoque NÃO foi alterado — confirme se a peça está mesmo na prateleira.`,
    evidencia: {
      cancelGroup: l.cancelGroup,
      shipmentStatus: l.shipmentStatus,
      removidoPelaVarredura: removido,
    },
  });
}

async function aplicar(linhas: Linha[]): Promise<{ ok: number; erro: number }> {
  let ok = 0;
  let erro = 0;
  for (const l of linhas.slice(0, LIMITE)) {
    try {
      const reason = `Baixa de devolução não recebida ML #${l.externalOrderId}`;

      // SÓ PERGUNTAR: o ML registrou a devolução como concluída, então a peça
      // provavelmente ESTÁ no pátio e o estoque é real. Remover aqui seria o
      // furo oposto — peça boa sumindo. Abre a pendência e não toca em nada.
      // Ver a decisão 3b no cabeçalho.
      if (l.acao === "SO_PERGUNTAR") {
        await abrirPendencia(l, 0);
        ok++;
        continue;
      }

      // a) estoque, na mesma tx e com lock — mesma ordem do motor.
      const removido = await prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<{ id: string; stock: number }[]>`
            SELECT id, stock FROM "Product" WHERE id = ${l.productId} FOR UPDATE`;
          const atual = locked[0]?.stock ?? 0;
          const jaBaixado = await tx.stockLog.aggregate({
            where: { productId: l.productId, reason },
            _sum: { change: true },
          });
          // Idempotência dentro da tx: se já houve baixa deste script para
          // este pedido, não repete.
          if ((jaBaixado._sum.change ?? 0) < 0) return 0;
          const remover = Math.min(l.aRemover, atual);
          if (remover <= 0) return 0;
          const novo = atual - remover;
          await tx.product.update({
            where: { id: l.productId },
            data: { stock: novo },
          });
          await tx.stockLog.create({
            data: {
              productId: l.productId,
              change: -remover,
              reason,
              previousStock: atual,
              newStock: novo,
            },
          });
          return remover;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      if (removido === 0) {
        continue;
      }

      // b) pausa em TODOS os canais, pelo motor da aplicação.
      const uc = new ProductUseCase();
      const r = await uc.pauseListings(l.productId, l.tenantId, "paused", {
        forceRemote: true,
      });

      // Falhas por anúncio, para o operador saber o que sobrou.
      // `pauseListings` devolve `success: true` em sucesso PARCIAL — acreditar
      // nele faria o script imprimir "0 falhas" com anúncio no ar, que é
      // exatamente o bug que esta varredura existe para matar.
      for (const lr of r.listingResults) {
        if (!lr.paused) {
          anunciosComFalha.push({
            email: l.email,
            sku: l.sku,
            externalListingId: lr.externalListingId,
            platform: String(lr.platform ?? "?"),
            erro: lr.error ?? "sem detalhe",
          });
        }
      }

      // ⭐ E a CONFERÊNCIA que vale: o que o banco diz depois da pausa.
      // O retorno da API é interpretação; `status = 'active'` é o fato. Um
      // anúncio que continua ativo com estoque 0 é peça comprável que a loja
      // não tem — o estado que esta varredura promete eliminar.
      const aindaAtivos = await prisma.productListing.findMany({
        where: { productId: l.productId, status: "active" },
        select: {
          externalListingId: true,
          marketplaceAccount: { select: { platform: true } },
        },
      });
      for (const a of aindaAtivos) {
        anunciosAindaVendaveis.push({
          email: l.email,
          sku: l.sku,
          externalListingId: a.externalListingId,
          platform: String(a.marketplaceAccount?.platform ?? "?"),
        });
      }

      // c) pendência, para o operador ainda poder dizer "a peça voltou".
      await abrirPendencia(l, removido);

      void SystemLogService.logWarning(
        "RETURN_PHANTOM_STOCK_REMEDIATED",
        `SKU ${l.sku}: ${removido} unidade(s) de estoque fantasma removida(s) e anúncios pausados (pedido ML #${l.externalOrderId}).`,
        {
          userId: l.tenantId,
          resource: "Product",
          resourceId: l.productId,
          details: {
            externalOrderId: l.externalOrderId,
            removido,
            desfecho: l.desfecho,
            cancelGroup: l.cancelGroup,
            shipmentStatus: l.shipmentStatus,
          },
        },
      ).catch(() => {});

      ok++;
    } catch (err) {
      erro++;
      console.error(
        `  ✗ ${l.sku} (#${l.externalOrderId}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { ok, erro };
}

function imprimirCsv(linhas: Linha[]) {
  const cols = [
    "email",
    "sku",
    "produto",
    "externalOrderId",
    "estornoEm",
    "desfecho",
    "cancelGroup",
    "shipmentStatus",
    "estoqueAtual",
    "anunciosAtivos",
    "aRemover",
    "acao",
  ] as const;
  console.log(cols.join(";"));
  for (const l of linhas) {
    console.log(
      cols.map((c) => String((l as any)[c] ?? "").replace(/;/g, ",")).join(";"),
    );
  }
}

function gravarRelatorio(linhas: Linha[], tenants: Tenant[]): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(process.cwd(), "audit-reports");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `estoque-fantasma-devolucao-${ts}.md`);

  const out: string[] = [];
  out.push("# Estoque fantasma de devolução");
  out.push("");
  out.push(`- Timestamp: ${new Date().toISOString()}`);
  out.push(`- Modo: ${APPLY ? "APLICAR" : "SIMULAÇÃO (nada foi alterado)"}`);
  out.push(`- Tenants varridos: ${tenants.length}`);
  out.push("");

  const porTenant = new Map<string, Linha[]>();
  for (const l of linhas) {
    porTenant.set(l.email, [...(porTenant.get(l.email) ?? []), l]);
  }

  if (porTenant.size === 0) {
    out.push("OK — nenhuma peça com estoque fantasma de devolução.");
  }
  for (const [email, ls] of [...porTenant].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const vendaveis = ls.filter(
      (l) => l.estoqueAtual > 0 && l.anunciosAtivos > 0,
    );
    out.push(`## ${email}`);
    out.push("");
    out.push(
      `- ${ls.length} peça(s) com estoque fantasma; **${vendaveis.length} vendável(is) agora**, em ${vendaveis.reduce((s, l) => s + l.anunciosAtivos, 0)} anúncio(s) no ar.`,
    );
    out.push("");
    out.push(
      "| SKU | produto | pedido ML | desfecho | envio | estoque | anúncios | ação |",
    );
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const l of ls) {
      out.push(
        `| ${l.sku} | ${l.produto.slice(0, 44)} | ${l.externalOrderId} | ${l.desfecho} | ${l.shipmentStatus} | ${l.estoqueAtual} | ${l.anunciosAtivos} | ${l.acao === "SO_PERGUNTAR" ? "só pergunta" : "zera + pausa"} |`,
      );
    }
    out.push("");
  }

  if (naoClassificadas_pecas.length > 0) {
    out.push("## ⚠ Peças NÃO classificadas");
    out.push("");
    out.push(
      "A API do Mercado Livre recusou ou falhou para estas peças em TODAS as contas do tenant. Elas não estão na lista acima, e isso não quer dizer que estejam certas.",
    );
    out.push("");
    for (const n of naoClassificadas_pecas) {
      out.push(`- ${n.email} — SKU ${n.sku} #${n.externalOrderId}: ${n.motivo}`);
    }
    out.push("");
  }

  if (truncadoPorTeto) {
    out.push("## ⚠ Relatório TRUNCADO");
    out.push("");
    out.push(
      `O teto de ${TETO_API} chamadas à API foi atingido (${chamadasApi} usadas). A lista está incompleta — rode de novo com \`--teto-api\` maior.`,
    );
    out.push("");
  }

  if (naoClassificadas.length > 0) {
    out.push("## ⚠ Contas NÃO classificadas");
    out.push("");
    out.push(
      "Estas contas não foram varridas. O passivo delas é desconhecido, não zero.",
    );
    out.push("");
    for (const n of naoClassificadas) {
      out.push(`- ${n.email} — ${n.conta}: ${n.motivo}`);
    }
    out.push("");
  }

  out.unshift("");
  out.unshift(
    `**Resumo:** ${linhas.length} peça(s) em ${porTenant.size} tenant(s); ${naoClassificadas.length} conta(s) e ${naoClassificadas_pecas.length} peça(s) não classificada(s); ${chamadasApi} chamada(s) à API${truncadoPorTeto ? " — **TRUNCADO**" : ""}.`,
  );

  writeFileSync(file, out.join("\n"), "utf8");
  return file;
}

async function run() {
  const tenants = await carregarTenants();
  const alvo = CONTA_ALVO
    ? tenants.filter((t) => t.email.toLowerCase() === CONTA_ALVO.toLowerCase())
    : tenants;

  if (APPLY && !CONTA_ALVO && !SIM_TODAS) {
    console.error(
      "Recusado: --apply exige alvo explícito. Use --conta <email> ou --sim-todas.",
    );
    process.exitCode = 1;
    return;
  }
  if (CONTA_ALVO && alvo.length === 0) {
    console.error(`Recusado: a conta ${CONTA_ALVO} não existe.`);
    process.exitCode = 1;
    return;
  }

  const linhas: Linha[] = [];
  for (const t of alvo) linhas.push(...(await levantar(t)));

  if (CSV) {
    imprimirCsv(linhas);
    // O CSV vai para o stdout (é o que a planilha lê), então os avisos vão
    // para o stderr — senão um relatório TRUNCADO viraria uma planilha curta
    // com cara de planilha completa, que é exatamente o que o cabeçalho
    // deste script proíbe.
    if (truncadoPorTeto) {
      console.error(
        `⚠ TRUNCADO: teto de ${TETO_API} chamadas atingido. A planilha está INCOMPLETA.`,
      );
    }
    if (naoClassificadas.length > 0 || naoClassificadas_pecas.length > 0) {
      console.error(
        `⚠ ${naoClassificadas.length} conta(s) e ${naoClassificadas_pecas.length} peça(s) NÃO classificadas — fora da planilha, e isso não quer dizer que estejam certas.`,
      );
    }
    process.exitCode = linhas.length > 0 || truncadoPorTeto ? 1 : 0;
    return;
  }

  console.log("");
  console.log("PEÇAS COM ESTOQUE FANTASMA DE DEVOLUÇÃO");
  console.log(
    APPLY
      ? "MODO: APLICAR (o estoque abaixo será zerado e os anúncios pausados)"
      : "MODO: SIMULAÇÃO — nada será alterado",
  );
  console.log("");

  const porTenant = new Map<string, Linha[]>();
  for (const l of linhas) {
    porTenant.set(l.email, [...(porTenant.get(l.email) ?? []), l]);
  }

  for (const [email, ls] of [...porTenant].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const vendaveis = ls.filter(
      (l) => l.estoqueAtual > 0 && l.anunciosAtivos > 0,
    );
    console.log(
      `${email} — ${ls.length} peça(s), ${vendaveis.length} vendável(is) agora`,
    );
    for (const l of ls) {
      console.log(
        `    · SKU ${String(l.sku).padEnd(10)} #${l.externalOrderId.padEnd(17)} ${l.desfecho.padEnd(21)} envio ${String(l.shipmentStatus).padEnd(14)} estoque ${l.estoqueAtual}  anúncios ${l.anunciosAtivos}  ${l.acao === "SO_PERGUNTAR" ? "[só pergunta]" : "[zera+pausa] "} ${l.produto.slice(0, 34)}`,
      );
    }
    console.log("");
  }

  console.log(
    `TOTAL: ${linhas.length} peça(s) em ${porTenant.size} tenant(s) (de ${alvo.length} varridos).`,
  );
  if (naoClassificadas.length > 0) {
    console.log("");
    console.log(
      `⚠ ${naoClassificadas.length} conta(s) NÃO classificada(s) — o passivo delas é desconhecido, não zero:`,
    );
    for (const n of naoClassificadas) {
      console.log(`    · ${n.email} — ${n.conta}: ${n.motivo}`);
    }
  }

  if (naoClassificadas_pecas.length > 0) {
    console.log("");
    console.log(
      `⚠ ${naoClassificadas_pecas.length} peça(s) que NENHUMA conta conseguiu classificar (a API do ML recusou ou falhou):`,
    );
    for (const n of naoClassificadas_pecas.slice(0, 20)) {
      console.log(`    · ${n.email} — SKU ${n.sku} #${n.externalOrderId}: ${n.motivo}`);
    }
    if (naoClassificadas_pecas.length > 20) {
      console.log(`    ... e mais ${naoClassificadas_pecas.length - 20}. Ver o relatório.`);
    }
  }

  if (truncadoPorTeto) {
    console.log("");
    console.log(
      `⚠ TRUNCADO: o teto de ${TETO_API} chamadas à API foi atingido (${chamadasApi} usadas). A lista está INCOMPLETA — rode de novo com --teto-api maior.`,
    );
  }
  console.log(`(${chamadasApi} chamadas à API do Mercado Livre nesta execução.)`);

  if (!SEM_RELATORIO) {
    const file = gravarRelatorio(linhas, alvo);
    console.log("");
    console.log(`📄 relatório salvo em ${file}`);
  }

  if (!APPLY) {
    console.log("");
    console.log(
      "Nada foi alterado. Para corrigir, confira a lista com o cliente e rode:",
    );
    console.log(
      "  npx tsx scripts/audit-estoque-fantasma-devolucao.ts --apply --conta <email>",
    );
    process.exitCode = linhas.length > 0 || truncadoPorTeto ? 1 : 0;
    return;
  }

  if (linhas.length > LIMITE) {
    console.log(
      `Teto de ${LIMITE} por execução: as primeiras ${LIMITE} serão corrigidas; rode de novo para as demais.`,
    );
  }
  console.log("");
  console.log("Corrigindo...");
  const { ok, erro } = await aplicar(linhas);
  console.log("");
  console.log(
    `Concluído: ${ok} peça(s) corrigida(s), ${erro} peça(s) com erro, ${anunciosComFalha.length} anúncio(s) que o motor não pausou.`,
  );

  if (anunciosComFalha.length > 0) {
    console.log("");
    console.log("Anúncios que o motor não conseguiu pausar:");
    for (const a of anunciosComFalha.slice(0, 30)) {
      console.log(
        `    · ${a.email} — SKU ${a.sku} ${a.platform} ${a.externalListingId}: ${a.erro}`,
      );
    }
    if (anunciosComFalha.length > 30) {
      console.log(`    ... e mais ${anunciosComFalha.length - 30}.`);
    }
    console.log(
      "  (Recusa por item já `closed` no ML ou já apagado na Shopee é inofensiva — está mais fora do ar que pausado.)",
    );
  }

  if (anunciosAindaVendaveis.length > 0) {
    console.log("");
    console.log(
      `🔴 ATENÇÃO: ${anunciosAindaVendaveis.length} anúncio(s) continuam ATIVOS com a peça em estoque 0 — são compráveis e a loja não tem a peça:`,
    );
    for (const a of anunciosAindaVendaveis) {
      console.log(
        `    · ${a.email} — SKU ${a.sku} ${a.platform} ${a.externalListingId}`,
      );
    }
    console.log("  Pause estes à mão antes de seguir para o próximo tenant.");
  } else {
    console.log("");
    console.log(
      "✓ Conferido no banco: nenhum anúncio ficou ativo com a peça zerada.",
    );
  }

  // Exit code pelo FATO, não pela intenção: anúncio comprável sem peça é
  // falha, mesmo que todas as peças tenham sido zeradas.
  process.exitCode =
    erro > 0 || anunciosAindaVendaveis.length > 0 ? 2 : 0;
}

run()
  .catch((err) => {
    // SÓ a mensagem. Imprimir o erro cru vaza segredo: o AxiosError carrega
    // `config.data`, e o corpo do refresh do ML tem `client_secret` e
    // `refresh_token` em texto puro. Aconteceu em 01/09/2026.
    console.error(
      "[audit-estoque-fantasma-devolucao] Falhou:",
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
