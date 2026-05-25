/**
 * Reparo automático de ownership de listings do Mercado Livre.
 *
 * Quando a remoção (`PUT /items/{id}` com `status=closed`) estoura 403, em
 * muitos casos a causa é o `ProductListing` local apontar para a CONTA
 * ERRADA — situação comum em importações em massa que vincularam o item
 * a uma conta que não é o `seller_id` real (ex.: importação JOTABÊ
 * vinculando MLB6658891678 a `JOTABE-AUTOPECAS` quando o dono real é
 * `DESMONTE-JOTABE`).
 *
 * Esta service tenta GET `/items/{id}` com cada outra conta ML ativa do
 * MESMO usuário. Se alguma retornar 200 e o `seller_id` da resposta bater
 * com o `externalUserId` da conta, encontramos o dono real — caller pode
 * reapontar o FK e tentar fechar com o token correto.
 */

import { Platform } from "@prisma/client";
import { MLApiService } from "./ml-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";

export interface AccountForRepair {
  id: string;
  externalUserId: string | null;
  accessToken: string | null;
}

export interface MLItemSnapshot {
  seller_id: number | string;
  status?: string;
  [key: string]: unknown;
}

export interface OwnershipRepairResult {
  repaired: boolean;
  /** ID da conta correta no banco (quando repaired=true). */
  newAccountId?: string;
  /** Access token da conta correta — caller usa pra refazer a chamada. */
  newAccountToken?: string;
  /** Status do item no ML (ex.: "active", "closed"). */
  itemStatus?: string;
  /** seller_id retornado pelo ML. */
  itemSellerId?: number | string;
  /** Mensagem explicando o resultado (sucesso ou falha). */
  reason: string;
}

export interface RepairDeps {
  findAccounts?: (
    userId: string,
  ) => Promise<AccountForRepair[]>;
  getItemDetails?: (
    accessToken: string,
    itemId: string,
  ) => Promise<MLItemSnapshot>;
}

/**
 * Tenta descobrir, entre as contas ML ativas do usuário, qual é o
 * verdadeiro dono do item no Mercado Livre.
 *
 * Não muta nada (só lê) — caller é responsável por reapontar o FK
 * e re-tentar a operação que estava falhando.
 */
export async function findCorrectMLAccount(opts: {
  userId: string;
  currentAccountId: string;
  externalListingId: string;
  deps?: RepairDeps;
}): Promise<OwnershipRepairResult> {
  const findAccounts =
    opts.deps?.findAccounts ??
    ((userId: string) =>
      MarketplaceRepository.findAllByUserIdAndPlatform(
        userId,
        Platform.MERCADO_LIVRE,
      ).then((rows) =>
        rows.map((r) => ({
          id: r.id,
          externalUserId: r.externalUserId,
          accessToken: r.accessToken,
        })),
      ));
  const getItemDetails =
    opts.deps?.getItemDetails ??
    ((token: string, itemId: string) =>
      MLApiService.getItemDetails(token, itemId) as Promise<MLItemSnapshot>);

  const accounts = await findAccounts(opts.userId);
  const candidates = accounts.filter(
    (a) => a.id !== opts.currentAccountId && !!a.accessToken,
  );

  if (candidates.length === 0) {
    return {
      repaired: false,
      reason:
        "Nenhuma outra conta ML conectada do mesmo usuário para tentar reparo",
    };
  }

  for (const acc of candidates) {
    try {
      const item = await getItemDetails(
        acc.accessToken as string,
        opts.externalListingId,
      );
      // ML retorna seller_id como number; normalizamos pra string pra evitar
      // armadilha de comparação numérica/string.
      const itemSeller = String(item.seller_id ?? "");
      const accSeller = String(acc.externalUserId ?? "");
      if (itemSeller && accSeller && itemSeller === accSeller) {
        return {
          repaired: true,
          newAccountId: acc.id,
          newAccountToken: acc.accessToken as string,
          itemStatus: item.status,
          itemSellerId: item.seller_id,
          reason: `Item pertence à conta ${acc.id} (seller_id=${itemSeller})`,
        };
      }
      // GET sucedeu mas seller não bate — esta conta lê o item mas não é
      // o dono. Tenta a próxima.
    } catch {
      // 401/403/404/5xx — apenas continua para a próxima conta. O catch
      // intencionalmente engole o erro porque cada conta é uma TENTATIVA
      // independente; só importa achar a certa.
    }
  }

  return {
    repaired: false,
    reason:
      "Nenhuma outra conta ML do usuário reconhece este item como seu — possivelmente o anúncio é de uma conta não conectada ou foi deletado",
  };
}
