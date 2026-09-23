import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";
import { MLApiService } from "./ml-api.service";
import { conferirVinculoNaVenda } from "@/app/marketplaces/lib/conferencia-vinculo-na-venda";

/**
 * VIGÍLIA DE TÍTULO — o anúncio ainda vende a peça que a Dexo acha que ele vende?
 * ==============================================================================
 *
 * POR QUE EXISTE
 * A Dexo publica o anúncio, guarda o vínculo e nunca mais relê o título. O
 * desmanche, por outro lado, REAPROVEITA o anúncio para outra peça quando a
 * primeira vende — mantém a posição e a reputação do anúncio. A partir daí a
 * venda de uma peça dá baixa em outra, em silêncio, para sempre.
 *
 * Medido em 23/09/2026: 566 anúncios ativos em 2 clientes (MK2 0,61%, Tijuco
 * Preto 2,04%) vendendo peça diferente da que a Dexo baixaria — todos com saldo.
 * Metade nasceu assim; a outra metade era vínculo grudado em anúncio alheio.
 *
 * ELA SÓ ACUSA. Nunca troca `productId`, nunca pausa anúncio, nunca mexe em
 * estoque. Religar é decisão com evidência dupla e mão humana: não existe
 * unicidade (produto, conta) no banco e `syncProductStock` empurra o estoque
 * CHEIO do produto para CADA anúncio dele, então religar no escuro troca "baixa
 * na peça errada" por venda dupla.
 *
 * POR QUE SERVIÇO PRÓPRIO E NÃO O ListingStatusSweepService
 * O cursor daquele sweep é keyset EM MEMÓRIA e zera a cada restart; com 100
 * anúncios por conta/hora sobre ~7.600, uma volta completa leva mais de 3 dias
 * e nenhuma passada é garantida. É a mesma doença que a vigília de
 * disponibilidade já teve (nunca passou do offset 4.000 de 10.698). Aqui a
 * fatia vem do RELÓGIO: determinística, sem estado, e a base inteira passa a
 * cada `LISTING_TITLE_WATCH_SLICES` horas mesmo com restart no meio.
 *
 * ⚠️ O token é LIDO do banco e nunca renovado: renovar fora da produção marca a
 * conta como ERROR e o lojista para de receber pedidos.
 *
 * Flags (backend liga com "1"):
 *   LISTING_TITLE_WATCH_ENABLED=1  liga a rotina (exige restart do pm2)
 *   LISTING_TITLE_WATCH_DRY=1      mede sem alertar o lojista (só console)
 */

const INTERVALO_MS = 60 * 60 * 1000;
const FATIAS = Number(process.env.LISTING_TITLE_WATCH_SLICES ?? 24);
// A base tem ~164 mil anuncios ML ativos: com 24 fatias, uma fatia e ~6.900.
// Um teto abaixo disso nao "anda mais devagar" — ele deixa o FIM de cada fatia
// sem verificacao em TODAS as passadas, que e exatamente a doenca do cursor em
// memoria que esta vigilia existe para nao ter.
const MAX_POR_TICK = Number(process.env.LISTING_TITLE_WATCH_MAX ?? 9000);
const DEDUPE_MS = 24 * 60 * 60 * 1000;

type Candidato = {
  listingId: string;
  externalListingId: string;
  productId: string;
  productName: string;
  titleOverride: string | null;
  sku: string | null;
  accountId: string;
  accountName: string;
  accessToken: string | null;
  ownerId: string;
};

export class ListingTitleWatchService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static emAndamento = false;

  /**
   * Qual fatia a hora do relógio manda varrer. Determinístico e sem estado:
   * duas passadas na mesma hora visitam a mesma fatia, e `FATIAS` horas visitam
   * todas. Recebe a data para que o teste não dependa do relógio real.
   */
  static sliceForClock(agora: Date, fatias = FATIAS): number {
    const horas = Math.floor(agora.getTime() / (60 * 60 * 1000));
    return ((horas % fatias) + fatias) % fatias;
  }

  static async watchTitlesOnce(agora = new Date()): Promise<void> {
    // A env é relida a cada tick de propósito: desligar vale no próximo tick,
    // sem esperar restart.
    if (process.env.LISTING_TITLE_WATCH_ENABLED !== "1") return;
    if (this.emAndamento) return;
    this.emAndamento = true;
    try {
      await this.percorrerFatia(agora);
    } catch (erro) {
      console.error("[title_watch] falhou:", erro instanceof Error ? erro.message : String(erro));
    } finally {
      this.emAndamento = false;
    }
  }

  private static async percorrerFatia(agora: Date): Promise<void> {
    const fatia = this.sliceForClock(agora);
    const seco = process.env.LISTING_TITLE_WATCH_DRY === "1";

    // `hashtext` distribui a fatia sem depender de data de criação — sem isso a
    // varredura visitaria sempre o pedaço mais novo do catálogo. `closed` fica
    // de fora: é terminal e o anúncio não volta sozinho.
    const candidatos = await prisma.$queryRaw<Candidato[]>`
      SELECT pl.id                       AS "listingId",
             pl."externalListingId"      AS "externalListingId",
             pl."titleOverride"          AS "titleOverride",
             p.id                        AS "productId",
             p.name                      AS "productName",
             p.sku                       AS "sku",
             ma.id                       AS "accountId",
             ma."accountName"            AS "accountName",
             ma."accessToken"            AS "accessToken",
             COALESCE(u."parentUserId", u.id) AS "ownerId"
        FROM "ProductListing" pl
        JOIN "Product" p ON p.id = pl."productId"
        JOIN "User" u ON u.id = p."userId"
        JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
       WHERE pl.status = 'active'
         AND ma.platform = 'MERCADO_LIVRE'
         AND ma.status = 'ACTIVE'
         AND ma."expiresAt" > NOW()
         AND pl."externalListingId" LIKE 'MLB%'
         AND (abs(hashtext(pl.id)) % ${FATIAS}) = ${fatia}
       LIMIT ${MAX_POR_TICK}
    `;

    if (candidatos.length === 0) return;

    const porConta = new Map<string, Candidato[]>();
    for (const c of candidatos) {
      porConta.set(c.accountId, [...(porConta.get(c.accountId) ?? []), c]);
    }

    let conferidos = 0;
    let divergentes = 0;
    for (const lista of porConta.values()) {
      const token = lista[0]?.accessToken;
      if (!token) continue;
      let remotos: Array<{ id: string; status: string; title: string; available_quantity: number }>;
      try {
        remotos = await MLApiService.getItemsTitleSnapshot(
          token,
          lista.map((c) => c.externalListingId),
        );
      } catch (erro) {
        // Falha de rede numa conta não pode derrubar a fatia inteira: a próxima
        // passada visita a MESMA fatia daqui a `FATIAS` horas.
        console.warn(
          `[title_watch] conta ${lista[0].accountName} falhou:`,
          erro instanceof Error ? erro.message : String(erro),
        );
        continue;
      }
      const porId = new Map(remotos.map((r) => [r.id, r]));
      for (const c of lista) {
        const remoto = porId.get(c.externalListingId);
        // Anúncio pausado ou zerado não expõe peça: não há dano a impedir, e
        // acusar aqui encheria a tela de alerta sem venda possível.
        if (!remoto || remoto.status !== "active" || Number(remoto.available_quantity ?? 0) <= 0) continue;
        conferidos += 1;
        const esperado = c.titleOverride ?? c.productName;
        const veredicto = conferirVinculoNaVenda(remoto.title, esperado);
        if (!veredicto.divergente) continue;
        divergentes += 1;
        if (seco) {
          console.warn(
            `[title_watch][seco] ${c.externalListingId} ${veredicto.veredicto} (${veredicto.semelhanca.toFixed(2)}): ${veredicto.motivo}`,
          );
          continue;
        }
        await this.alertarDeriva(c, remoto.title, veredicto.veredicto, veredicto.semelhanca, veredicto.motivo);
      }
    }

    console.warn(
      `[title_watch] fatia ${fatia}/${FATIAS}: ${candidatos.length} candidatos, ${conferidos} no ar conferidos, ${divergentes} divergentes${seco ? " (modo seco)" : ""}`,
    );
  }

  private static async alertarDeriva(
    c: Candidato,
    tituloRemoto: string,
    veredicto: string,
    semelhanca: number,
    motivo: string,
  ): Promise<void> {
    try {
      const desde = new Date(Date.now() - DEDUPE_MS);
      const existe = await prisma.systemLog.findFirst({
        where: { action: "ML_LISTING_TITLE_DRIFT", resourceId: c.listingId, createdAt: { gte: desde } },
        select: { id: true },
      });
      if (existe) return;

      await SystemLogService.logError(
        "ML_LISTING_TITLE_DRIFT",
        `O anúncio ${c.externalListingId} está vendendo "${tituloRemoto}", mas na Dexo ele aponta para a peça ${c.sku ?? "?"} — ${c.productName}. Enquanto estiver assim, a venda desse anúncio dá baixa na peça errada.`,
        {
          // Sem `userId` o alerta não aparece para o lojista: a tela de logs
          // filtra por empresa. Foi esse o defeito dos alertas anteriores.
          userId: c.ownerId,
          resource: "Listing",
          resourceId: c.listingId,
          details: {
            platform: "MERCADO_LIVRE",
            accountId: c.accountId,
            accountName: c.accountName,
            externalListingId: c.externalListingId,
            productId: c.productId,
            productSku: c.sku,
            tituloNoAnuncio: tituloRemoto,
            pecaVinculada: c.productName,
            veredicto,
            semelhanca: Number(semelhanca.toFixed(2)),
            motivo,
          },
        },
      );
    } catch (erro) {
      console.warn(
        `[title_watch] nao consegui alertar ${c.externalListingId}:`,
        erro instanceof Error ? erro.message : String(erro),
      );
    }
  }

  static start(intervalMs = INTERVALO_MS): void {
    if (this.intervalId) return;
    const ligada = process.env.LISTING_TITLE_WATCH_ENABLED === "1";
    const seco = process.env.LISTING_TITLE_WATCH_DRY === "1";
    // O boot diz os DOIS estados de propósito: a vigília de disponibilidade
    // passou semanas desligada sem ninguém notar, porque ligada e desligada
    // eram igualmente silenciosas.
    console.warn(
      `[title_watch] ${ligada ? "started" : "DESLIGADA (LISTING_TITLE_WATCH_ENABLED != 1)"}` +
        (ligada ? ` (interval=${intervalMs}ms, fatias=${FATIAS}, maxPorTick=${MAX_POR_TICK}${seco ? ", MODO SECO" : ""})` : ""),
    );
    if (!ligada) return;
    this.intervalId = setInterval(() => {
      void this.watchTitlesOnce();
    }, intervalMs);
  }

  static stop(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }
}
