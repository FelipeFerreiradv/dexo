import prisma from "../lib/prisma";
import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { createNfeProvider } from "../fiscal/providers/provider-factory";
import type { NfeStatus, FiscalAmbiente } from "../fiscal/domain/nfe.types";
import { canTransition } from "../fiscal/domain/nfe.types";

export interface CancelResult {
  success: boolean;
  nfeId: string;
  status: NfeStatus;
  protocolo: string | null;
  mensagem: string;
}

/**
 * Cancelamento de NF-e autorizada.
 *
 * Regras:
 *  - Somente notas com status AUTHORIZED podem ser canceladas
 *  - Justificativa obrigatória (min 15 caracteres — exigência SEFAZ)
 *  - Deve ter chave de acesso e protocolo de autorização
 *  - Prazo de cancelamento: 24h após autorização (validado server-side)
 */
export class NfeCancelamentoUseCase {
  private nfeRepo: NfeRepository;
  private configRepo: CompanyFiscalRepository;

  constructor() {
    this.nfeRepo = new NfeRepository();
    this.configRepo = new CompanyFiscalRepository();
  }

  async cancel(
    userId: string,
    nfeId: string,
    justificativa: string,
  ): Promise<CancelResult> {
    // ── 1. Validate justificativa ──
    if (!justificativa || justificativa.trim().length < 15) {
      throw new Error(
        "Justificativa obrigatoria (minimo 15 caracteres)",
      );
    }

    // ── 2. Load NF-e ──
    const nfe = await (prisma as any).nfeEmitida.findFirst({
      where: { id: nfeId, userId },
    });
    if (!nfe) {
      throw new Error("NF-e nao encontrada");
    }
    if (nfe.status !== "AUTHORIZED") {
      throw new Error(
        `Somente notas autorizadas podem ser canceladas (status atual: ${nfe.status})`,
      );
    }
    if (!nfe.chaveAcesso) {
      throw new Error("NF-e sem chave de acesso — nao pode ser cancelada");
    }
    if (!nfe.protocoloAutorizacao) {
      throw new Error(
        "NF-e sem protocolo de autorizacao — nao pode ser cancelada",
      );
    }

    // ── 3. Check 24h window ──
    const autorizadaEm = nfe.dataAutorizacao ?? nfe.createdAt;
    const horasDesdeAutorizacao =
      (Date.now() - new Date(autorizadaEm).getTime()) / (1000 * 60 * 60);
    if (horasDesdeAutorizacao > 24) {
      throw new Error(
        "Prazo de cancelamento expirado (maximo 24 horas apos autorizacao)",
      );
    }

    // ── 4. Load config ──
    const config = await this.configRepo.findByUserId(userId);
    if (!config) {
      throw new Error("Configuracao fiscal nao encontrada");
    }
    if (!config.providerToken) {
      throw new Error("Token do provedor fiscal nao configurado");
    }

    // ── 5. Call provider ──
    const provider = createNfeProvider(
      config.providerName,
      config.ambiente as FiscalAmbiente,
    );
    const result = await provider.cancelar({
      ref: nfeId,
      chaveAcesso: nfe.chaveAcesso,
      protocolo: nfe.protocoloAutorizacao,
      justificativa: justificativa.trim(),
      token: config.providerToken,
    });

    if (!result.success) {
      await this.nfeRepo.addAuditLog(nfeId, userId, "CANCELAMENTO_REJEITADO", {
        mensagem: result.mensagem,
      });
      return {
        success: false,
        nfeId,
        status: "AUTHORIZED",
        protocolo: null,
        mensagem: result.mensagem,
      };
    }

    // ── 6. Transition AUTHORIZED → CANCELLED ──
    if (!canTransition("AUTHORIZED", "CANCELLED")) {
      throw new Error("Transicao invalida: AUTHORIZED → CANCELLED");
    }

    await (prisma as any).nfeEmitida.update({
      where: { id: nfeId },
      data: {
        status: "CANCELLED",
        motivoRejeicao: justificativa.trim(), // reuse field for cancel reason
      },
    });

    await this.nfeRepo.addAuditLog(nfeId, userId, "CANCELADA", {
      justificativa: justificativa.trim(),
      protocolo: result.protocolo,
    });

    return {
      success: true,
      nfeId,
      status: "CANCELLED",
      protocolo: result.protocolo,
      mensagem: "NF-e cancelada com sucesso",
    };
  }
}
