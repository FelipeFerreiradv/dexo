import prisma from "../lib/prisma";
import { isDevolucaoAtiva, isNumeracaoV2ParaEmissao } from "../fiscal/flags";
import { NfeNumeracaoService } from "../fiscal/numeracao/numeracao.service";
import { NfeDevolucaoRepository } from "../fiscal/devolucao/devolucao.repository";
import { DevolucaoError } from "../fiscal/devolucao/devolucao.errors";
import { tabelaFiscalAusente } from "../fiscal/numeracao/numeracao.errors";
import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import {
  createNfeProvider,
  createNfeProviderFromConfig,
} from "../fiscal/providers/provider-factory";
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
    // Multi-CNPJ: o certificado/provedor tem que ser o do CNPJ EMISSOR da
    // nota (nota antiga sem configId = era 1-CNPJ ⇒ padrão do tenant).
    const config = nfe.companyFiscalConfigId
      ? await this.configRepo.findByIdForUser(nfe.companyFiscalConfigId, userId)
      : await this.configRepo.findByUserId(userId);
    if (!config) {
      throw new Error("Configuracao fiscal do emitente nao encontrada");
    }
    const isSefazDirect = config.providerName === "SEFAZ_DIRECT";
    if (!isSefazDirect && !config.providerToken) {
      throw new Error("Token do provedor fiscal nao configurado");
    }

    // ── 5. Call provider ──
    const provider = isSefazDirect
      ? await createNfeProviderFromConfig({
          providerName: "SEFAZ_DIRECT",
          ambiente: config.ambiente as FiscalAmbiente,
          uf: config.uf,
          certificadoPath: config.certificadoPath,
          certificadoSenhaEnc: config.certificadoSenhaEnc,
        })
      : createNfeProvider(config.providerName, config.ambiente as FiscalAmbiente, {
          // NFC-e via Focus cancela no path /v2/nfce (modelo da propria nota).
          // Ausente/55 ⇒ /v2/nfe (comportamento atual intacto).
          modelo: nfe.modelo === "65" ? "65" : "55",
        });

    let v2=isNumeracaoV2ParaEmissao(config.id,nfe.modelo==="65"?"65":"55",config.providerName);
    const numeros=new NfeNumeracaoService();
    if(v2)try{await numeros.reservaViva(userId,nfeId);}catch(e){if(tabelaFiscalAusente(e))v2=false;else throw e;}
    const executeCancel=async():Promise<CancelResult>=>{
    const result = await provider.cancelar({
      ref: v2?(await numeros.focusRefAutorizada(userId,nfeId))??nfeId:nfeId,
      chaveAcesso: nfe.chaveAcesso,
      protocolo: nfe.protocoloAutorizacao,
      justificativa: justificativa.trim(),
      token: config.providerToken ?? "",
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
    if(v2)await numeros.marcarCancelado(userId,nfeId);

    return {
      success: true,
      nfeId,
      status: "CANCELLED",
      protocolo: result.protocolo,
      mensagem: "NF-e cancelada com sucesso",
    };
    };
    if(isDevolucaoAtiva(config.id)) {
      const devolucao=new NfeDevolucaoRepository();
      return prisma.$transaction(async tx=>{
        await devolucao.lockOrigens(tx,userId,[nfe.chaveAcesso]);
        const linhas=await devolucao.linhasSaldo(userId,nfe.chaveAcesso,tx);
        if(linhas.some(l=>["AUTHORIZED","VALIDATING","SIGNING","SENDING"].includes(l.statusDevolucao)))throw new DevolucaoError("ORIGINAL_COM_DEVOLUCAO");
        return executeCancel();
      },{timeout:600000,maxWait:5000});
    }
    return executeCancel();
  }
}
