import { Platform } from "@prisma/client";
import { ListingRepository } from "../repositories/listing.repository";
import { MLApiService } from "./ml-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SystemLogService } from "../../services/system-log.service";
import { MLOAuthService } from "./ml-oauth.service";
import { isPlatformDisabled } from "@/app/lib/integration-flags";
import {
  classifyFacebookRemoveError,
  classifyOlxRemoveError,
} from "./listing-removal.helpers";
import { isMlRequiredAttrsBlockEnabled } from "../lib/ml-required-attributes.logic";
import { placeholderMlSettings } from "../lib/ml-placeholder-settings";
import {
  LAST_ERROR_MARKER,
  isTerminalMarker,
} from "../lib/ml-error-normalizer";
import { decideReconcile } from "../lib/ml-reconcile.logic";
import { sanitizeMLTitle } from "../lib/ml-title";
import { normalizeListingStatus } from "../lib/listing-status";

const BACKOFF_SECONDS = [30, 60, 120, 300, 900]; // exponential-ish backoff
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
// Candidatos por passada. Cada um custa varias chamadas sequenciais ao ML, e
// nao ha rate limit no servico — lotes grandes fazem a passada durar dezenas
// de minutos.
const RETRY_BATCH_SIZE = Number(process.env.LISTING_RETRY_BATCH || 25);
// Lease do claim atômico por candidato (trava entre processos). Precisa
// cobrir o pior caso de UM candidato (escada completa + upload de imagens,
// ~1-2min); se o processo morrer no meio, o candidato volta à fila sozinho
// quando o lease expira. Os caminhos normais sobrescrevem o lease no fim
// (sucesso desliga o retry; falha grava o backoff real).
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Pre-compiled regex for Shopee terminal error detection
const SHOPEE_TERMINAL_RE =
  /excede os limites de todos os canais|duplicates? another|duplicate.*shop|selecione uma categoria|categoria.*inv[aá]lida|n[ãa]o foi poss[ií]vel obter os atributos da categoria/i;

export class ListingRetryService {
  private static running = false;
  private static intervalId: NodeJS.Timeout | null = null;
  /** Trava de reentrância de runOnce. `running` só controla o setInterval. */
  private static passInFlight = false;

  /**
   * Run a single pass: find placeholders / pending retries and try to create them on ML.
   *
   * Guarda contra passadas sobrepostas: cada candidato faz ~13-23 chamadas
   * sequenciais ao ML, então uma passada cheia pode durar mais que o intervalo
   * do setInterval (e o endpoint POST /ml/retry-pending dispara runOnce em
   * paralelo ao cron). Sem a trava, duas passadas leem o mesmo lote — a
   * primeira escrita de um candidato só acontece no fim do seu ciclo — e
   * chamam createItem para os mesmos listings, criando anúncios DUPLICADOS
   * e órfãos no ML (sem linha no banco, invisíveis à plataforma).
   */
  static async runOnce() {
    if (this.passInFlight) {
      console.log(
        "[ListingRetryService] passada anterior ainda em execução — ignorando este disparo",
      );
      return;
    }
    this.passInFlight = true;
    try {
      return await this.runPass();
    } finally {
      this.passInFlight = false;
    }
  }

  private static async runPass() {
    console.log("[ListingRetryService] runOnce start");
    const now = new Date();
    const candidates = await ListingRepository.findPendingRetries(
      now,
      RETRY_BATCH_SIZE,
    );
    console.log(`[ListingRetryService] candidates=${candidates?.length || 0}`);

    for (const cand of candidates) {
      // O claim do ML marca `pending` (cron publicando); devolvido no fim.
      let marcouPublicando = false;
      try {
        console.log(`[ListingRetryService] processing candidate ${cand.id}`);

        // Claim atômico ANTES de qualquer efeito: a trava `passInFlight` só
        // vale dentro deste processo, e em produção já houve um segundo cron
        // em paralelo (node órfão de um restart do pm2, rodando código de um
        // deploy anterior). Sem o claim, dois processos leem o mesmo lote e
        // criam o mesmo anúncio duas vezes no ML. O UPDATE condicional é
        // atômico — quem perder a corrida pula o candidato.
        // Só placeholder PENDING_ do ML: marcar `pending` numa linha com id
        // REAL a esconderia das guardas de anúncio vivo (status fora da lista)
        // e o cron poderia publicar um segundo anúncio do mesmo produto.
        const ehMl =
          cand.marketplaceAccount?.platform === "MERCADO_LIVRE" &&
          !!cand.externalListingId?.startsWith("PENDING_") &&
          !cand.externalListingId?.startsWith("PENDING_SHP_");
        const claimed = await ListingRepository.claimRetryCandidate(
          cand.id,
          CLAIM_LEASE_MS,
          ehMl ? { markPublishing: true } : {},
        );
        marcouPublicando = ehMl && !!claimed;
        // A reserva do cron é o passe dele no createMLListing: linha com
        // retry ligado só é reaproveitada por quem a reservou.
        const reservaDoCron =
          claimed instanceof Date
            ? { reservation: { listingId: cand.id, at: claimed } }
            : undefined;
        if (!claimed) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (claimed por outro processo ou estado mudou)`,
          );
          continue;
        }

        // only handle placeholders (externals starting with PENDING_) or retryEnabled
        if (
          !cand.externalListingId?.startsWith("PENDING_") &&
          !cand.retryEnabled
        ) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (not placeholder/retryEnabled)`,
          );
          continue;
        }

        // defensive: skip if product missing
        if (!cand.product) {
          console.log(`[ListingRetryService] skipping ${cand.id} (no product)`);
          continue;
        }

        const account = cand.marketplaceAccount;

        // Shopee placeholders: delegar para ListingUseCase.createShopeeListing
        if (
          account?.platform === "SHOPEE" ||
          cand.externalListingId?.startsWith("PENDING_SHP_")
        ) {
          console.log(
            `[ListingRetryService] delegating Shopee retry for ${cand.id} to createShopeeListing`,
          );
          try {
            const { ListingUseCase } =
              await import("../usecases/listing.usercase");
            const result = await ListingUseCase.createShopeeListing(
              account?.userId || "",
              cand.productId,
              cand.requestedCategoryId || undefined,
              account?.id,
            );
            if (result.success) {
              console.log(
                `[ListingRetryService] Shopee retry succeeded for ${cand.id}: ${result.externalListingId}`,
              );
            } else {
              // createShopeeListing already updates the listing placeholder in its
              // own catch block (with terminal classification and attempt tracking).
              // Log here for observability only.
              console.warn(
                `[ListingRetryService] Shopee retry failed for ${cand.id}: ${result.error}`,
              );
            }
          } catch (shopeeErr) {
            const msg = errMsg(shopeeErr);
            console.error(
              `[ListingRetryService] Shopee retry exception for ${cand.id}:`,
              msg,
            );
            // Classify terminal Shopee errors that should stop retry
            const isTerminal = SHOPEE_TERMINAL_RE.test(msg);

            const attempts = (cand.retryAttempts || 0) + 1;
            const shouldRetry = !isTerminal && attempts < MAX_ATTEMPTS;
            const nextDelay =
              BACKOFF_SECONDS[
                Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
              ];
            await ListingRepository.incrementRetryAttempts(cand.id, {
              lastError:
                (isTerminal ? "[TERMINAL] " : "") + msg.substring(0, 490),
              nextRetryAt: shouldRetry
                ? new Date(Date.now() + nextDelay * 1000)
                : null,
              retryEnabled: shouldRetry,
            });
            if (isTerminal) {
              console.warn(
                `[ListingRetryService] Shopee terminal error for ${cand.id} — retry disabled`,
              );
            }
          }
          continue;
        }
        // OLX e Facebook: delegar ao create da própria plataforma, no mesmo
        // desenho do branch da Shopee acima. Antes destes ramos, os dois caíam
        // no guard abaixo e tinham o retry DESLIGADO — ou seja, uma falha
        // transitória (5xx da OLX, rate limit da Meta) matava o anúncio na
        // primeira tentativa e ele nunca mais era republicado.
        // Não replicar a condição `startsWith("PENDING_")`: OLX/Facebook não
        // usam placeholder — o externalListingId deles já é o SKU.
        if (
          account?.platform === Platform.OLX ||
          account?.platform === Platform.FACEBOOK
        ) {
          const ehOlx = account.platform === Platform.OLX;
          const nome = ehOlx ? "OLX" : "Facebook";

          // Kill-switch: com a integração pausada, este cron NÃO pode continuar
          // publicando. Reagenda sem consumir tentativa — quando o operador
          // religar, o candidato volta à fila no estado em que estava.
          if (isPlatformDisabled(account.platform)) {
            await ListingRepository.incrementRetryAttempts(
              cand.id,
              {
                nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
                lastError: `${nome} pausado por kill-switch — retry adiado`,
              },
              // O comentário acima prometia "sem consumir tentativa" e o código
              // fazia o contrário: com o cron a cada 30 min, 2h30 de pausa
              // esgotavam as 5 tentativas e o anúncio saía da fila sem NUNCA
              // ter sido publicado.
              { increment: false },
            );
            continue;
          }

          try {
            const { ListingUseCase } =
              await import("../usecases/listing.usercase");
            const result = ehOlx
              ? await ListingUseCase.createOlxListing(
                  account?.userId || "",
                  cand.productId,
                  cand.requestedCategoryId || undefined,
                  account?.id,
                )
              : await ListingUseCase.createFacebookListing(
                  account?.userId || "",
                  cand.productId,
                  cand.requestedCategoryId || undefined,
                  account?.id,
                );
            if (!result.success) {
              // TETO DE TENTATIVAS.
              //
              // Diferente do branch da Shopee, createOlxListing e
              // createFacebookListing NÃO lançam: devolvem { success:false } e o
              // catch deles regrava `retryEnabled: true` com nextRetryAt de 60s.
              // Sem o bloco abaixo, uma recusa DEFINITIVA (preço suspeito, sem
              // vaga no plano, imagem pequena) voltaria a ser publicada a cada
              // 60 segundos, para sempre — ~1.440 chamadas/dia por anúncio.
              //
              // Classifica com o mesmo vocabulário já usado na remoção, para
              // erro permanente sair da fila na primeira vez.
              // ⚠️ O Error precisa carregar os SINAIS, não só o texto.
              //
              // Os classificadores decidem permanente vs. transitório lendo
              // `status` (5xx/429), `responseData.statusCode` (OLX) e
              // `responseData.error.code` (rate limit da Graph: 4/17/32/613),
              // além de `code` para ECONNRESET/ETIMEDOUT. Um `new Error(msg)`
              // nu deixa todos eles `undefined` e o DEFAULT dos dois
              // classificadores é "permanent" — então um 503 da OLX ou um rate
              // limit da Meta tirava o anúncio da fila para SEMPRE, que é o
              // oposto do que este bloco existe para fazer. Só as poucas
              // substrings ("timeout", "socket hang up") escapavam.
              const msg = result.error ?? "Erro desconhecido";
              const erroRico = new Error(msg);
              (erroRico as any).status = result.errorStatus;
              (erroRico as any).responseData = result.errorResponseData;
              (erroRico as any).code = result.errorCode;
              const classificacao = ehOlx
                ? classifyOlxRemoveError(erroRico)
                : classifyFacebookRemoveError(erroRico);
              const ehPermanente = classificacao.kind === "permanent";
              const attempts = (cand.retryAttempts || 0) + 1;
              const shouldRetry = !ehPermanente && attempts < MAX_ATTEMPTS;
              const nextDelay =
                BACKOFF_SECONDS[
                  Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
                ];
              await ListingRepository.incrementRetryAttempts(cand.id, {
                lastError:
                  (ehPermanente ? "[TERMINAL] " : "") + msg.substring(0, 490),
                nextRetryAt: shouldRetry
                  ? new Date(Date.now() + nextDelay * 1000)
                  : null,
                retryEnabled: shouldRetry,
              });
              console.warn(
                `[ListingRetryService] retry ${nome} falhou para ${cand.id} (tentativa ${attempts}/${MAX_ATTEMPTS}${ehPermanente ? ", TERMINAL" : ""}): ${msg}`,
              );
            }
          } catch (err) {
            const msg = errMsg(err);
            console.error(
              `[ListingRetryService] exceção no retry ${nome} para ${cand.id}:`,
              msg,
            );
            const attempts = (cand.retryAttempts || 0) + 1;
            const shouldRetry = attempts < MAX_ATTEMPTS;
            const nextDelay =
              BACKOFF_SECONDS[
                Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
              ];
            await ListingRepository.incrementRetryAttempts(cand.id, {
              lastError: msg.substring(0, 490),
              nextRetryAt: shouldRetry
                ? new Date(Date.now() + nextDelay * 1000)
                : null,
              retryEnabled: shouldRetry,
            });
          }
          continue;
        }

        // Só MERCADO_LIVRE segue no caminho ML: Magalu não pode enviar
        // seu token para api.mercadolibre.com (vazamento de token).
        // DESABILITA o retry ao pular: este é o único publish-retry e
        // claimRetryCandidate é agnóstico de plataforma — sem desligar, um
        // candidato Magalu/OLX/FB é reivindicado (write no banco) a cada ciclo,
        // p/ sempre, e nunca sai da fila.
        if (account?.platform && account.platform !== Platform.MERCADO_LIVRE) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (plataforma ${account.platform} não suportada pelo retry ML) — retry desabilitado`,
          );
          await ListingRepository.incrementRetryAttempts(cand.id, {
            retryEnabled: false,
            nextRetryAt: null,
            lastError: "[TERMINAL] plataforma sem retry",
          });
          continue;
        }

        if (!account || !account.accessToken) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (no account/token)`,
          );
          continue;
        }

        // Token do ML expirado: renovar antes de falar com a API.
        //
        // O fluxo interativo (ListingUseCase.createMLListing) já faz isso, e
        // por isso o cron raramente pegava token vencido: quando um anúncio
        // falha e entra na fila, o token acabou de ser renovado por lá. Mas o
        // cron também processa candidatos que ficaram parados (fila drenando
        // após um deploy, backlog reabilitado em lote) — aí o token pode ter
        // vencido no meio do caminho. Sem renovar, o capability check abaixo
        // falha, as tentativas se esgotam e o anúncio é desligado por token
        // vencido, não por problema no anúncio: um motivo falso no lugar do
        // outro que este serviço acabou de deixar de dar.
        //
        // Renova o objeto em memória (como createMLListing faz com `acc`), de
        // modo que os usos seguintes de account.accessToken peguem o valor
        // novo sem tocar em cada call site.
        if (account.expiresAt < new Date()) {
          try {
            console.log(
              `[ListingRetryService] ML token expirado (conta ${account.id}) — renovando`,
            );
            const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
              account.id,
              account.refreshToken,
            );
            await MarketplaceRepository.updateTokens(account.id, {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
            });
            account.accessToken = refreshed.accessToken;
            account.refreshToken = refreshed.refreshToken;
          } catch (refreshErr) {
            // Deliberadamente NÃO marca a conta como ERROR (credencial morta é
            // marcada pelo MLOAuthService — invalid_grant, client_id_mismatch —
            // e pelo classificador central no createMLListing). Um erro transitório de rede aqui derrubaria a conta para
            // todos os fluxos — sync, pedidos, mensagens — a partir de um cron
            // sem contexto de usuário. Reagenda: se o refreshToken estiver
            // mesmo inválido, as tentativas se esgotam e o anúncio para com uma
            // mensagem acionável, e a reconexão passa pelo fluxo interativo.
            const attempts = (cand.retryAttempts || 0) + 1;
            const shouldRetry = attempts < MAX_ATTEMPTS;
            const nextDelay =
              BACKOFF_SECONDS[
                Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
              ];
            console.warn(
              `[ListingRetryService] falha ao renovar token da conta ${account.id}: ${errMsg(refreshErr)}`,
            );
            await ListingRepository.incrementRetryAttempts(cand.id, {
              lastError: manterVerificar(
                cand.lastError,
                `Token do Mercado Livre expirado e não foi possível renovar — reconecte a conta "${account.accountName || account.id}" em Integrações`,
              ),
              nextRetryAt: shouldRetry
                ? new Date(Date.now() + nextDelay * 1000)
                : null,
              retryEnabled: shouldRetry,
            });
            continue;
          }
        }

        // Quick capability check
        try {
          console.log(
            `[ListingRetryService] capability check for account ${account.id}`,
          );
          await MLApiService.getSellerItemIds(
            account.accessToken,
            String(account.externalUserId || account.userId),
            "active",
            1,
          );
        } catch (capErr) {
          console.log(
            `[ListingRetryService] capability check failed for ${cand.id}: ${errMsg(capErr)}`,
          );
          // schedule next retry
          const attempts = (cand.retryAttempts || 0) + 1;
          const nextDelay =
            BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
          // Última tentativa: sem horário. Retry desligado COM horário futuro
          // é a marca de "publicação em andamento" (reserva do botão/criação)
          // e deixava o card em "Publicando agora" por 15 min sem nada rodar.
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: manterVerificar(cand.lastError, errMsg(capErr)),
            nextRetryAt:
              attempts < MAX_ATTEMPTS
                ? new Date(Date.now() + nextDelay * 1000)
                : null,
            retryEnabled: attempts < MAX_ATTEMPTS,
          });

          await SystemLogService.logError(
            "RETRY_LISTING" as any,
            `Capability check failed for placeholder ${cand.id} (scheduling retry): ${errMsg(capErr)}`,
            { resource: "ProductListing", resourceId: cand.id },
          );
          continue;
        }

        console.log(
          `[ListingRetryService] capability OK for ${cand.id}, delegando criação`,
        );

        const product = cand.product as any;

        // Guard terminal: stock/price inválidos nunca serão aceitos pelo ML
        // (item.stock.invalid / item.price.invalid). O createMLListing valida o
        // mesmo, mas retorna sem marcar terminal — o candidato gastaria os 5
        // ciclos de backoff para morrer no mesmo ponto. Cortar aqui poupa a
        // rotação até o usuário corrigir o cadastro.
        //
        // `cand.product` vem do `include: { product: true }` de
        // findPendingRetries, ou seja, é o Product CRU do Prisma: `price` é um
        // Decimal (typeof === "object"), não number. Comparar com
        // `typeof === "number"` reprovava TODO produto, com qualquer preço, e
        // marcava o anúncio como terminal com a mensagem falsa "price=0" —
        // sobrescrevendo o lastError real. Daí o Number() antes de comparar.
        const stockNum = Number(product.stock);
        const priceNum = Number(product.price);
        const hasValidStock = Number.isFinite(stockNum) && stockNum > 0;
        const hasValidPrice = Number.isFinite(priceNum) && priceNum > 0;
        if (!hasValidStock || !hasValidPrice) {
          const reason =
            !hasValidStock && !hasValidPrice
              ? "sem estoque e sem preço"
              : !hasValidStock
                ? "sem estoque (stock=0)"
                : "sem preço (price=0)";
          console.warn(
            `[ListingRetryService] skipping ${cand.id} permanently — produto ${reason}`,
          );
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: `[TERMINAL] Produto ${reason} — corrija no cadastro e recrie o anúncio`,
            nextRetryAt: null,
            retryEnabled: false,
          });
          continue;
        }

        // Criacao no ML: delegar para ListingUseCase.createMLListing — o mesmo
        // padrao que este servico ja usa para o Shopee acima.
        //
        // Ate aqui, este arquivo REIMPLEMENTAVA a criacao (payload, titulo,
        // descricao, atributos, upload de imagem, preflight, escada de retry).
        // A copia foi ficando para tras do original e acumulou defeitos que o
        // fluxo principal ja tinha resolvido: 5 variantes de createItem contra
        // 12, sem retry por categoria sugerida, mandando family_name junto com
        // title (o ML rejeita: UP flow nao aceita os dois), e reportando sempre
        // o erro da 1a tentativa. Medido em producao: 2 lotes piloto de 25
        // anuncios reabilitados, 0 publicados nos dois.
        //
        // Delegar herda tudo do original — escada completa, categoria sugerida,
        // compatibilidades, reconciliacao de listing_type e a mensagem
        // acionavel — e elimina a duplicacao que causava a divergencia.
        //
        // createMLListing REUSA a linha existente (findByProductAndAccount),
        // entao o placeholder deste candidato e atualizado no lugar.
        // Anti-duplicata: a tentativa anterior terminou em timeout/5xx e pode
        // ter criado o item no ML sem a Dexo saber. Confere na conta ANTES de
        // criar de novo; achou ⇒ adota o item, não cria.
        if (
          typeof cand.lastError === "string" &&
          cand.lastError.startsWith(LAST_ERROR_MARKER.VERIFICAR)
        ) {
          const conferencia = await this.reconcileBeforeRecreate(
            cand as any,
            account as any,
          );
          // adopted / ambiguous / search_failed: nada a criar nesta passada.
          if (conferencia !== "not_found") continue;
        }

        const { ListingUseCase } = await import("../usecases/listing.usercase");
        // Configurações escolhidas na criação (tipo de anúncio, frete, garantia),
        // guardadas no placeholder. Sem nenhuma ⇒ chamada igual à de sempre.
        const settingsDoPlaceholder = placeholderMlSettings(cand as any);
        // Com ML_REQUIRED_ATTRS_BLOCK=1, a ficha que a criação original guardou
        // no placeholder (lado/posição e obrigatórios preenchidos na Revisão
        // individual) volta para esta retentativa. Sem ela, o bloqueio de
        // obrigatórios avaliaria só o cadastro do produto e marcaria terminal
        // por um campo que o operador preencheu. Flag desligada: a chamada
        // continua com os mesmos 4 argumentos de sempre.
        const fichaGuardada = (cand as { attributesOverride?: unknown })
          .attributesOverride;
        const result =
          isMlRequiredAttrsBlockEnabled() &&
          !!fichaGuardada &&
          typeof fichaGuardada === "object" &&
          !Array.isArray(fichaGuardada)
            ? reservaDoCron
              ? await ListingUseCase.createMLListing(
                  account.userId,
                  cand.productId,
                  cand.requestedCategoryId || undefined,
                  account.id,
                  settingsDoPlaceholder, // mlSettings
                  undefined, // titleOverride
                  undefined, // actorId
                  fichaGuardada as Record<string, unknown>,
                  reservaDoCron,
                )
              : await ListingUseCase.createMLListing(
                  account.userId,
                  cand.productId,
                  cand.requestedCategoryId || undefined,
                  account.id,
                  settingsDoPlaceholder, // mlSettings
                  undefined, // titleOverride
                  undefined, // actorId
                  fichaGuardada as Record<string, unknown>,
                )
            : reservaDoCron
              ? await ListingUseCase.createMLListing(
                  account.userId,
                  cand.productId,
                  cand.requestedCategoryId || undefined,
                  account.id,
                  settingsDoPlaceholder,
                  undefined,
                  undefined,
                  undefined,
                  reservaDoCron,
                )
              : settingsDoPlaceholder
                ? await ListingUseCase.createMLListing(
                    account.userId,
                    cand.productId,
                    cand.requestedCategoryId || undefined,
                    account.id,
                    settingsDoPlaceholder,
                  )
                : await ListingUseCase.createMLListing(
                    account.userId,
                    cand.productId,
                    cand.requestedCategoryId || undefined,
                    account.id,
                  );

        // Outra publicação do mesmo par em andamento (ou agendada noutra
        // linha): não é falha deste candidato. Volta à fila sem gastar
        // tentativa e sem trocar o erro — o [VERIFICAR] tem de seguir na
        // linha para a próxima passada conferir antes de recriar.
        if (
          !result.success &&
          (result as { code?: string }).code === "PUBLICATION_IN_PROGRESS"
        ) {
          await ListingRepository.incrementRetryAttempts(
            cand.id,
            { nextRetryAt: new Date(Date.now() + 60 * 1000) },
            { increment: false },
          );
          continue;
        }

        if (result.success) {
          console.log(
            `[ListingRetryService] ML retry succeeded for ${cand.id}: ${(result as any).externalListingId}`,
          );
          await SystemLogService.logError(
            "RETRY_LISTING" as any,
            `Placeholder ${cand.id} successfully posted to ML (${(result as any).externalListingId})`,
            { resource: "ProductListing", resourceId: cand.id },
          );
          continue;
        }

        // Falta de atributo obrigatório (só emitido com ML_REQUIRED_ATTRS_BLOCK=1)
        // é definitiva. Marcamos AQUI, pelo id do candidato: o createMLListing
        // grava na linha que findByProductAndAccount escolhe (prefere qualquer
        // PENDING_ do par), que pode não ser esta — e a releitura abaixo não
        // veria o terminal, reagendando o candidato em loop.
        if (result.terminal === true) {
          console.warn(
            `[ListingRetryService] ML retry terminal (atributo obrigatório) for ${cand.id}: ${result.error}`,
          );
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: `[TERMINAL] ${(result.error || "").substring(0, 480)}`,
            retryEnabled: false,
            nextRetryAt: null,
          });
          continue;
        }

        // Erro de DADO (ou conta a reconectar): repetir o mesmo corpo só repete
        // a recusa. Grava no candidato, pelo id, com o marcador que o create
        // devolveu — `[TERMINAL][CORRIGIVEL]` é re-armado quando a pessoa edita
        // o produto (ProductUseCase.update).
        if (isTerminalMarker(result.lastErrorMarker)) {
          console.warn(
            `[ListingRetryService] ML retry terminal (${result.errorKind}) for ${cand.id}: ${result.error}`,
          );
          // Candidato com id REAL (anúncio encerrado publicado de novo) e o
          // bloqueio gravado num placeholder PENDING_ próprio: o marcador fica
          // lá, onde o re-arme e o botão enxergam. Aqui só sai da fila — com o
          // marcador, esta linha ficaria sem saída.
          if (
            !String(cand.externalListingId ?? "").startsWith("PENDING_") &&
            result.listingId &&
            result.listingId !== cand.id
          ) {
            await ListingRepository.incrementRetryAttempts(cand.id, {
              retryEnabled: false,
              nextRetryAt: null,
            });
            continue;
          }
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: `${result.lastErrorMarker} ${result.error || ""}`
              .trim()
              .substring(0, 490),
            retryEnabled: false,
            nextRetryAt: null,
          });
          continue;
        }

        // Falhou. O createMLListing ja gravou o erro na linha, mas reagenda com
        // `retryEnabled: true` fixo, sem olhar MAX_ATTEMPTS — e o loop infinito
        // que este servico existe para cortar. Reaplicamos o backoff daqui.
        //
        // Antes, relemos a linha DO CANDIDATO (pelo id — o par produto/conta
        // pode ter varias linhas): se o createMLListing classificou o erro como
        // TERMINAL (ex.: PolicyAgent, ou anuncio duplicado nesta conta), ele
        // deixa retryEnabled=false e nao devemos ressuscitar o candidato.
        const afterAttempt = await ListingRepository.findRetryStateById(
          cand.id,
        );
        if (afterAttempt && afterAttempt.retryEnabled === false) {
          console.warn(
            `[ListingRetryService] ML retry terminal for ${cand.id}: ${result.error}`,
          );
          continue;
        }

        const attempts = (cand.retryAttempts || 0) + 1;
        const shouldRetry = attempts < MAX_ATTEMPTS;
        const nextDelay =
          BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
        console.warn(
          `[ListingRetryService] ML retry failed for ${cand.id} (tentativa ${attempts}/${MAX_ATTEMPTS}): ${result.error}`,
        );
        await ListingRepository.incrementRetryAttempts(cand.id, {
          // `[VERIFICAR]` segue na linha: a próxima passada confere no ML
          // antes de criar de novo (a tentativa pode ter criado o item).
          lastError: (result.lastErrorMarker
            ? `${result.lastErrorMarker} ${result.error || "erro desconhecido"}`
            : result.error || "erro desconhecido"
          ).substring(0, 490),
          nextRetryAt: shouldRetry
            ? new Date(Date.now() + nextDelay * 1000)
            : null,
          retryEnabled: shouldRetry,
        });
      } catch (err) {
        // unexpected error
        try {
          // Respeita MAX_ATTEMPTS como os demais ramos: `retryEnabled: true`
          // fixo reagendava o candidato a cada 60s para sempre — o loop
          // infinito que o guard terminal acima existe para cortar.
          const attempts = (cand.retryAttempts || 0) + 1;
          const shouldRetry = attempts < MAX_ATTEMPTS;
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: manterVerificar(cand.lastError, errMsg(err)),
            nextRetryAt: shouldRetry ? new Date(Date.now() + 60 * 1000) : null,
            retryEnabled: shouldRetry,
          });
        } catch (e) {
          /* ignore */
        }
        await SystemLogService.logError(
          "RETRY_LISTING" as any,
          `Unexpected error while retrying placeholder ${cand.id}: ${errMsg(err)}`,
          { resource: "ProductListing", resourceId: cand.id },
        );
      } finally {
        if (marcouPublicando) {
          try {
            await ListingRepository.restoreCronClaimStatus(
              cand.id,
              String(cand.status ?? "error"),
            );
          } catch {
            // o próximo claim do cron regrava; a linha segue com retry
          }
        }
      }
    }
  }

  /**
   * Antes de RECRIAR um anúncio cuja tentativa anterior terminou em timeout ou
   * 5xx: busca na conta os anúncios com o SKU do produto e, se um deles foi
   * criado a partir do placeholder, ADOTA-o (vincula o id real) em vez de
   * criar outro. Resultado:
   *  - "adopted": vinculado, nada a criar;
   *  - "search_failed": não deu para conferir — reagenda SEM criar (criar às
   *    cegas é exatamente o risco de duplicata);
   *  - "not_found": nenhum item novo; segue para a criação normal.
   */
  static async reconcileBeforeRecreate(
    cand: {
      id: string;
      createdAt: Date;
      productId?: string;
      retryAttempts?: number | null;
      lastError?: string | null;
      marketplaceAccountId?: string;
      product?: { sku?: string | null; name?: string | null } | null;
    },
    account: {
      id: string;
      accessToken: string;
      externalUserId?: string | null;
    },
    /**
     * `interactive` = botão "Tentar publicar novamente": busca que falha não
     * grava nada (nem tentativa, nem marcador, nem agendamento) — a pessoa
     * tenta de novo; o cron é quem agenda.
     */
    opts: { interactive?: boolean } = {},
  ): Promise<"adopted" | "ambiguous" | "search_failed" | "not_found"> {
    const sku = (cand.product?.sku || "").trim();
    const sellerId = (account.externalUserId || "").trim();
    // Sem SKU ou sem vendedor não há como conferir: segue como sempre foi.
    if (!sku || !sellerId) return "not_found";

    let items: Awaited<ReturnType<typeof MLApiService.findItemsBySellerSku>>;
    try {
      items = await MLApiService.findItemsBySellerSku(
        account.accessToken,
        sellerId,
        sku,
      );
    } catch (err) {
      if (opts.interactive) {
        console.warn(
          JSON.stringify({
            event: "ml.publish.reconcile",
            outcome: "search_failed",
            interactive: true,
            listingId: cand.id,
            error: errMsg(err),
          }),
        );
        return "search_failed";
      }
      const attempts = (cand.retryAttempts || 0) + 1;
      const shouldRetry = attempts < MAX_ATTEMPTS;
      const nextDelay =
        BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
      console.warn(
        JSON.stringify({
          event: "ml.publish.reconcile",
          outcome: "search_failed",
          listingId: cand.id,
          error: errMsg(err),
        }),
      );
      await ListingRepository.incrementRetryAttempts(cand.id, {
        // Sempre COM o marcador: a próxima passada precisa conferir de novo
        // antes de criar (sem ele, recriava às cegas o item que talvez exista).
        lastError: comVerificar(
          cand.lastError ||
            "Não foi possível conferir no Mercado Livre se o anúncio já existe.",
        ),
        nextRetryAt: shouldRetry ? new Date(Date.now() + nextDelay * 1000) : null,
        retryEnabled: shouldRetry,
      });
      return "search_failed";
    }

    const decisao = decideReconcile(items, {
      placeholderCreatedAt: new Date(cand.createdAt),
      sku,
      desiredTitle: cand.product?.name
        ? sanitizeMLTitle(cand.product.name, sku)
        : null,
    });
    if (decisao.kind === "ambiguous") {
      await ListingRepository.updateListing(cand.id, {
        status: "error",
        lastError: `[TERMINAL] Há um anúncio no Mercado Livre (${decisao.item.id}) com o mesmo SKU, criado agora, mas com outro título ("${String(decisao.item.title ?? "").slice(0, 80)}"). Confira no Mercado Livre se é este produto antes de publicar de novo.`,
        retryEnabled: false,
        nextRetryAt: null,
      });
      console.warn(
        JSON.stringify({
          event: "ml.publish.reconcile",
          outcome: "ambiguous",
          listingId: cand.id,
          externalListingId: decisao.item.id,
        }),
      );
      return "ambiguous";
    }
    const achado = decisao.kind === "adopt" ? decisao.item : null;
    if (!achado) {
      console.log(
        JSON.stringify({
          event: "ml.publish.reconcile",
          outcome: "not_found",
          listingId: cand.id,
          remoteCandidates: items.length,
        }),
      );
      return "not_found";
    }

    // Já existe OUTRA linha para este anúncio nesta conta (unique): não duplica
    // o vínculo — encerra o placeholder apontando para ele.
    const jaVinculado = await ListingRepository.findLinkByExternalListingId(
      account.id,
      achado.id,
    );
    if (
      jaVinculado &&
      jaVinculado.id !== cand.id &&
      cand.productId &&
      jaVinculado.productId !== cand.productId
    ) {
      // Vinculado a OUTRO produto: não é este — a pessoa confere.
      await ListingRepository.updateListing(cand.id, {
        status: "error",
        lastError: `[TERMINAL] O anúncio ${achado.id}, com o mesmo SKU, está vinculado a outro produto. Confira no Mercado Livre antes de publicar de novo.`,
        retryEnabled: false,
        nextRetryAt: null,
      });
      return "ambiguous";
    }
    if (jaVinculado && jaVinculado.id !== cand.id) {
      await ListingRepository.updateListing(cand.id, {
        status: "error",
        lastError: `[TERMINAL] O anúncio ${achado.id} já existe no Mercado Livre e já está vinculado — exclua este pendente.`,
        retryEnabled: false,
        nextRetryAt: null,
      });
      console.warn(
        JSON.stringify({
          event: "ml.publish.reconcile",
          outcome: "already_linked",
          listingId: cand.id,
          externalListingId: achado.id,
        }),
      );
      return "adopted";
    }

    await ListingRepository.updateListing(cand.id, {
      externalListingId: achado.id,
      status:
        normalizeListingStatus("MERCADO_LIVRE", achado.status) ?? "active",
      permalink: achado.permalink ?? null,
      lastError: null,
      retryEnabled: false,
      nextRetryAt: null,
      retryAttempts: 0,
    });
    console.warn(
      JSON.stringify({
        event: "ml.publish.reconcile",
        outcome: "adopted",
        listingId: cand.id,
        externalListingId: achado.id,
        remoteStatus: achado.status,
      }),
    );
    return "adopted";
  }

  static start(intervalMs = 60 * 1000) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId as NodeJS.Timeout);
    this.intervalId = null;
    this.running = false;
  }
}

/**
 * Texto com o `[VERIFICAR]` na frente (tirando outros marcadores): a próxima
 * passada confere no ML antes de criar.
 */
export function comVerificar(texto: string): string {
  const limpo = String(texto ?? "").replace(/^(\[[A-Z]+\])+\s*/, "");
  return `${LAST_ERROR_MARKER.VERIFICAR} ${limpo}`.substring(0, 490);
}

/**
 * Regrava `lastError` sem perder o `[VERIFICAR]`: se a linha estava marcada
 * (a tentativa anterior pode ter criado o item no ML), o texto novo mantém o
 * marcador — senão a passada seguinte recriava sem conferir.
 */
export function manterVerificar(
  anterior: string | null | undefined,
  texto: string,
): string {
  const limpo = String(texto ?? "").replace(/^\[VERIFICAR\]\s*/, "");
  if (typeof anterior === "string" && anterior.startsWith(LAST_ERROR_MARKER.VERIFICAR)) {
    return `${LAST_ERROR_MARKER.VERIFICAR} ${limpo}`.substring(0, 490);
  }
  return String(texto ?? "");
}
