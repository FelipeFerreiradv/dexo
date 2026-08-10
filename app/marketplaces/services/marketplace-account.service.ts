import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SystemLogService } from "../../services/system-log.service";
import { AccountStatus } from "@prisma/client";

export interface MarketplaceAccountServiceHandleResult {
  setToError: boolean;
  message: string;
}

export class MarketplaceAccountService {
  /**
   * Handle errors that may indicate authentication/token problems.
   * If the error message looks like an auth failure, mark account as ERROR and log.
   * Otherwise only log the incident and do not change account status.
   */
  static async handleAuthFailure(
    accountId: string,
    err: unknown,
    options?: { userId?: string; context?: string },
  ) {
    const msg = err instanceof Error ? err.message : String(err || "");

    const isAuthFailure = [
      "unauthorized",
      "invalid access token",
      "invalid_client",
      "invalid_grant",
      "invalid grant",
      "client_id does not match the original",
      "refresh failed",
      "token expired",
      "invalid_refresh_token",
      // Vocabulário da Graph API (Meta). O long-lived token expira em ~60 dias
      // e não tem refresh: sem estas chaves a conta ficava ACTIVE para sempre,
      // verde na tela de Integrações, falhando toda publicação em silêncio.
      // São expressões específicas da Meta — não colidem com ML/Shopee/Magalu.
      "oauthexception",
      "error validating access token",
      "session has expired",
      "invalid oauth access token",
      // OLX: o autoupload devolve 200 com o erro no corpo; a mensagem já chega
      // aqui achatada por olxRespError.
      "invalid_token",
      "token revoked",
    ].some((k) => msg.toLowerCase().includes(k));

    if (isAuthFailure) {
      try {
        await MarketplaceRepository.updateStatus(
          accountId,
          AccountStatus.ERROR,
        );
      } catch (e) {
        // log and continue
        console.error(
          "[MarketplaceAccountService] failed to set ERROR status:",
          e,
        );
      }

      try {
        await SystemLogService.logError(
          (options?.context as any) || "MARKETPLACE_AUTH",
          `Marked account ERROR due to auth failure: ${msg}`,
          {
            userId: options?.userId,
            resource: "MarketplaceAccount",
            resourceId: accountId,
            details: { mlError: msg },
          },
        );
      } catch (logErr) {
        console.error(
          "[MarketplaceAccountService] failed to write SystemLog:",
          logErr,
        );
      }

      return { setToError: true, message: msg };
    }

    // Not an auth failure: log as warning and keep account as-is
    try {
      await SystemLogService.logError(
        (options?.context as any) || "MARKETPLACE_WARNING",
        `Marketplace non-auth error encountered: ${msg}`,
        {
          userId: options?.userId,
          resource: "MarketplaceAccount",
          resourceId: accountId,
          details: { mlError: msg },
        },
      );
    } catch (logErr) {
      console.error(
        "[MarketplaceAccountService] failed to write SystemLog:",
        logErr,
      );
    }

    return { setToError: false, message: msg };
  }

  static async setInactiveForVacation(
    accountId: string,
    options?: { userId?: string; message?: string },
  ) {
    try {
      await MarketplaceRepository.updateStatus(
        accountId,
        AccountStatus.INACTIVE,
      );
    } catch (e) {
      console.error(
        "[MarketplaceAccountService] failed to set INACTIVE status:",
        e,
      );
    }

    try {
      await SystemLogService.logError(
        "MARKETPLACE_VACATION" as any,
        options?.message || "Account marked INACTIVE due to vacation detected",
        {
          userId: options?.userId,
          resource: "MarketplaceAccount",
          resourceId: accountId,
          details: { reason: "vacation" },
        },
      );
    } catch (logErr) {
      console.error(
        "[MarketplaceAccountService] failed to write vacation SystemLog:",
        logErr,
      );
    }
  }
}
