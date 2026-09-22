import prisma from "../lib/prisma";
import { isDevolucaoAtiva, isNumeracaoV2ParaEmissao } from "../fiscal/flags";
import { NfeNumeracaoService } from "../fiscal/numeracao/numeracao.service";
import { NfeDevolucaoRepository } from "../fiscal/devolucao/devolucao.repository";
import { DevolucaoError } from "../fiscal/devolucao/devolucao.errors";
import { tabelaFiscalAusente } from "../fiscal/numeracao/numeracao.errors";
import { logNumeracao } from "../fiscal/numeracao/log";
import { FocusNfeV2Client } from "../fiscal/providers/focus-nfe-v2.client";
import { normalizarChaveAcesso } from "../fiscal/domain/chave-acesso-dv";
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

    const modelo=nfe.modelo==="65"?"65":"55";
    let v2=isNumeracaoV2ParaEmissao(config.id,modelo,config.providerName);
    const numeros=new NfeNumeracaoService();
    // Ledger (global ligado): a ref Focus e o CANCELADO vêm da reserva da NOTA, não da
    // config atual — após rollback da allowlist/sub-flag a nota renumerada (ref `…n<nº>`)
    // continua cancelável e o ledger não diverge. Global desligado: nenhuma consulta (I8).
    let ledger=process.env.NFE_NUMERACAO_V2_ENABLED==="true";
    let viva:Awaited<ReturnType<NfeNumeracaoService["reservaViva"]>>=null;
    let ref=nfeId;
    if(ledger)try{
      viva=await numeros.reservaViva(userId,nfeId);
      if(!isSefazDirect)ref=(await numeros.focusRefAutorizada(userId,nfeId))??nfeId;
    }catch(e){if(tabelaFiscalAusente(e)){ledger=false;v2=false;viva=null;ref=nfeId;}else throw e;}
    // Ramo V2 Focus (config na V2, ou nota com reserva V2 viva pelo ledger): cliente novo,
    // sucesso só com status "cancelado" + cStat 135/155 — um falso sucesso levaria a reserva
    // a CANCELADO, estado terminal. Nota legada (sem reserva) fora da V2 e flag global
    // desligada seguem no provider V1, byte a byte (golden focus-v1-cancelar).
    const v2Focus=!isSefazDirect && (v2 || !!viva);
    const executeCancel=async():Promise<CancelResult>=>{
    let detalhesFalha:Record<string,unknown>={};
    const result = v2Focus
      ? await new FocusNfeV2Client(config.ambiente==="PRODUCAO"?"PRODUCAO":"HOMOLOGACAO",modelo).cancelar(ref,justificativa.trim(),config.providerToken??"").then(r=>{
          detalhesFalha={cStat:r.cStat,httpStatus:r.httpStatus,transporte:r.transporte,status:r.corpo?.status??null};
          return {success:r.sucesso,protocolo:r.protocolo,mensagem:r.mensagem};
        })
      : await provider.cancelar({
      ref,
      chaveAcesso: nfe.chaveAcesso,
      protocolo: nfe.protocoloAutorizacao,
      justificativa: justificativa.trim(),
      token: config.providerToken ?? "",
    });

    if (!result.success) {
      await this.nfeRepo.addAuditLog(nfeId, userId, "CANCELAMENTO_REJEITADO", {
        mensagem: result.mensagem,
        ...(v2Focus?detalhesFalha:{}),
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
    // Só reserva AUTORIZADO vira CANCELADO. O cancelamento fiscal já foi efetivado:
    // falha aqui não pode virar erro para o usuário (a nota já está CANCELLED) — só log.
    if(ledger && viva && viva.estado!=="CANCELADO") {
      const campos={userId,nfeId,numero:viva.numero,serie:viva.serie,estado:viva.estado};
      if(viva.estado==="AUTORIZADO") {
        try{await numeros.marcarCancelado(userId,nfeId);}
        catch(e){logNumeracao("cancelamento_ledger_nao_marcado",{...campos,motivo:e instanceof Error?e.message:String(e)},"error");}
      } else logNumeracao("cancelamento_ledger_divergente",campos,"warn");
    }

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
      // A devolução grava a chave da original com 44 dígitos (CHECK ^[0-9]{44}$); a Focus V1
      // grava "NFe"+44. Lock e saldo usam a normalizada; o provider recebe a chave crua.
      const chaveOriginal=normalizarChaveAcesso(nfe.chaveAcesso)??nfe.chaveAcesso;
      return prisma.$transaction(async tx=>{
        await devolucao.lockOrigens(tx,userId,[chaveOriginal]);
        const linhas=await devolucao.linhasSaldo(userId,chaveOriginal,tx);
        if(linhas.some(l=>["AUTHORIZED","VALIDATING","SIGNING","SENDING"].includes(l.statusDevolucao)))throw new DevolucaoError("ORIGINAL_COM_DEVOLUCAO");
        return executeCancel();
      },{timeout:600000,maxWait:5000});
    }
    return executeCancel();
  }
}
