import prisma from "../lib/prisma";
import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { NfeSequenceService } from "../fiscal/sequence/nfe-sequence.service";
import { FiscalCalculatorService } from "../fiscal/calculators/fiscal-calculator.service";
import { NfeXmlBuilderService } from "../fiscal/generators/nfe-xml-builder.service";
import { DanfePdfService } from "../fiscal/generators/danfe-pdf.service";
import { FiscalStorageService } from "../fiscal/storage/fiscal-storage.service";
import {
  createNfeProvider,
  createNfeProviderFromConfig,
} from "../fiscal/providers/provider-factory";
import type { SefazEmitPayload } from "../fiscal/providers/sefaz-direct.provider";
import {
  shouldFallbackToSvc,
  getSvcType,
  isAutoFallbackEnabled,
} from "../fiscal/sefaz/contingencia.service";
import type { UF } from "../fiscal/sefaz/endpoints";
import type { NfeItemInput, RegimeTributario, NfeStatus, FiscalAmbiente } from "../fiscal/domain/nfe.types";
import { canTransition } from "../fiscal/domain/nfe.types";
import type { NfeDraftResponse } from "../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../interfaces/company-fiscal.interface";

export interface EmissionResult {
  success: boolean;
  nfeId: string;
  status: NfeStatus;
  numero: number;
  serie: number;
  chaveAcesso: string | null;
  protocolo: string | null;
  mensagem: string;
}

/**
 * Orquestra o fluxo completo de emissão:
 *
 * 1. Valida dados do rascunho
 * 2. Calcula tributos
 * 3. Reserva número atômico
 * 4. Monta payload Focus NFe
 * 5. Envia ao provedor
 * 6. Consulta resultado (polling)
 * 7. Armazena XML autorizado + gera DANFE
 * 8. Atualiza status no banco
 */
export class NfeEmissionUseCase {
  private nfeRepo: NfeRepository;
  private configRepo: CompanyFiscalRepository;
  private sequenceService: NfeSequenceService;
  private calculator: FiscalCalculatorService;
  private xmlBuilder: NfeXmlBuilderService;
  private danfeService: DanfePdfService;
  private storage: FiscalStorageService;

  constructor() {
    this.nfeRepo = new NfeRepository();
    this.configRepo = new CompanyFiscalRepository();
    this.sequenceService = new NfeSequenceService();
    this.calculator = new FiscalCalculatorService();
    this.xmlBuilder = new NfeXmlBuilderService();
    this.danfeService = new DanfePdfService();
    this.storage = new FiscalStorageService();
  }

  async emit(userId: string, nfeId: string): Promise<EmissionResult> {
    // ── 1. Load draft ──
    const draft = await this.nfeRepo.findDraftById(userId, nfeId);
    if (!draft) {
      throw new Error("Rascunho nao encontrado");
    }
    if (draft.status !== "DRAFT") {
      throw new Error(`NF-e nao esta em rascunho (status: ${draft.status})`);
    }

    // ── 2. Load config ──
    const config = await this.configRepo.findByUserId(userId);
    if (!config) {
      throw new Error("Configuracao fiscal nao encontrada");
    }
    if (!config.providerToken) {
      throw new Error("Token do provedor fiscal nao configurado");
    }

    // ── 3. Validate ──
    this.validate(draft, config);

    // ── Claim atomico DRAFT → VALIDATING (USE-7) ──
    // updateMany condicional ao status DRAFT garante que duas chamadas
    // concorrentes de emit() (duplo-clique, retry de cliente/fila) nao
    // reservem dois numeros e enviem duas NF-e para a mesma venda. Apenas a
    // primeira "ganha" o DRAFT; as demais abortam aqui.
    const claimed = await (prisma as any).nfeEmitida.updateMany({
      where: { id: nfeId, userId, status: "DRAFT" },
      data: { status: "VALIDATING" },
    });
    if (claimed.count === 0) {
      throw new Error(
        "NF-e ja esta em processamento de emissao (status nao e mais DRAFT)",
      );
    }

    // Marca o ponto-de-nao-retorno: apos o envio a SEFAZ, NUNCA revertemos para
    // DRAFT (poderia reemitir uma NF-e ja autorizada). Ver USE-3.
    let sentToSefaz = false;

    try {
      // ── 4. Calculate taxes ──
      const regime = config.regimeTributario as RegimeTributario;
      const itensInput: NfeItemInput[] = draft.itens.map((item) => ({
        quantidade: Number(item.quantidade),
        valorUnitario: Number(item.valorUnitario),
        desconto: Number(item.desconto ?? 0),
        ncm: item.ncm,
        cfop: item.cfop,
        origem: (item.origem ?? 0) as any,
        cstIcms: item.cstIcms ?? (regime === "SIMPLES" ? "102" : "00"),
        cstPis: (item.cstPis ?? (regime === "SIMPLES" ? "49" : "01")) as any,
        cstCofins: (item.cstCofins ?? (regime === "SIMPLES" ? "49" : "01")) as any,
        aliquotaIcms: item.aliquotaIcms ?? null,
        aliquotaIpi: item.aliquotaIpi ?? null,
        aliquotaPis: item.aliquotaPis ?? null,
        aliquotaCofins: item.aliquotaCofins ?? null,
        reducaoBcIcms: item.reducaoBcIcms ?? null,
      }));

      const calcResult = this.calculator.calcular(regime, itensInput);

      // Persist tributos per item
      for (let i = 0; i < draft.itens.length; i++) {
        draft.itens[i].tributosJson = calcResult.itens[i];
      }

      // Update draft with calculated totals and item tributos
      await this.nfeRepo.updateDraft(userId, nfeId, {
        totaisJson: calcResult.totais,
        itens: draft.itens,
      });

      // Reload draft with updated data
      const updatedDraft = await this.loadNfe(nfeId);

      // ── 5. Reserve number ──
      const ambiente = config.ambiente as FiscalAmbiente;
      const numero = await this.sequenceService.reservarProximoNumero(
        userId,
        ambiente,
        draft.serie,
      );

      // Update numero on the NFe. The draft row was created with an initial
      // ambiente (hardcoded HOMOLOGACAO historically), but the user may have
      // switched the fiscal config to PRODUCAO in the meantime. Align the row's
      // ambiente with the sequence we just reserved the number from — otherwise
      // the unique index (userId, ambiente, serie, numero) collides with rows
      // emitted in the other ambiente.
      await (prisma as any).nfeEmitida.update({
        where: { id: nfeId },
        data: {
          numero,
          ambiente,
          dataEmissao: new Date(),
          emitenteJson: this.buildEmitenteSnapshot(config),
        },
      });

      await this.nfeRepo.addAuditLog(nfeId, userId, "NUMERADA", {
        numero,
        serie: draft.serie,
      });

      // ── Transition: VALIDATING → SIGNING ──
      await this.transitionStatus(nfeId, userId, "VALIDATING", "SIGNING");

      // ── 6. Build payload + select provider ──
      // Reload with numero
      const nfeWithNumero = await this.loadNfe(nfeId);

      const isSefazDirect = config.providerName === "SEFAZ_DIRECT";
      let payload: any;
      let xmlOriginalContent: string;

      if (isSefazDirect) {
        // SEFAZ direto: provider monta + assina + envia o XML. Aqui apenas
        // empacotamos a fonte (draft + config + numero) — a serialização XML
        // efetiva acontece dentro do provider.
        const sefazPayload: SefazEmitPayload = {
          draft: nfeWithNumero,
          config,
          numero,
        };
        payload = sefazPayload;
        // Audit/storage: salvamos um snapshot legível do payload de entrada
        // (não é o XML assinado — esse fica em xmlAutorizadoPath após emit).
        xmlOriginalContent = JSON.stringify(
          { providerName: "SEFAZ_DIRECT", numero, draft: nfeWithNumero, config: redactConfig(config) },
          null,
          2,
        );
      } else {
        // Focus NFe: builder produz JSON proprietário que o provider envia.
        payload = this.xmlBuilder.build(nfeWithNumero, config, numero);
        xmlOriginalContent = JSON.stringify(payload, null, 2);
      }

      // Save payload as "XML original" — JSON em ambos os caminhos, formato
      // diferente conforme provider.
      const xmlOriginalPath = await this.storage.saveXmlOriginal(
        userId,
        nfeId,
        xmlOriginalContent,
      );

      await (prisma as any).nfeEmitida.update({
        where: { id: nfeId },
        data: { xmlOriginalPath },
      });

      // ── Transition: SIGNING → SENDING ──
      await this.transitionStatus(nfeId, userId, "SIGNING", "SENDING");

      await this.nfeRepo.addAuditLog(nfeId, userId, "ENVIADA", {
        providerName: config.providerName,
      });

      // ── 7. Send to provider ──
      const provider = isSefazDirect
        ? await createNfeProviderFromConfig({
            providerName: "SEFAZ_DIRECT",
            ambiente: config.ambiente as any,
            uf: config.uf,
            certificadoPath: config.certificadoPath,
            certificadoSenhaEnc: config.certificadoSenhaEnc,
          })
        : createNfeProvider(config.providerName, config.ambiente as any);

      // Ponto-de-nao-retorno: a partir daqui a SEFAZ pode ter recebido/autorizado.
      sentToSefaz = true;
      let providerResult = await provider.emitir({
        nfeData: payload,
        token: config.providerToken ?? "",
        ref: nfeId,
      });

      // ── 7a. Persistir a chave retornada IMEDIATAMENTE (USE-3) ──
      // Antes de qualquer processamento que possa lancar, gravamos a chave de
      // acesso — assim nunca perdemos o vinculo com a NF-e enviada a SEFAZ.
      if (isSefazDirect && providerResult.chaveAcesso) {
        await (prisma as any).nfeEmitida.update({
          where: { id: nfeId },
          data: { chaveAcesso: providerResult.chaveAcesso },
        });
      }

      // ── 7b. Contingencia SVC (so SEFAZ direto, opt-in via env) ──
      if (isSefazDirect && isAutoFallbackEnabled() && config.uf) {
        const decision = shouldFallbackToSvc(providerResult);
        const svcType = getSvcType(config.uf as UF);

        if (decision.shouldFallback) {
          // SEFAZ origem explicitamente fora (108/109/280-289): o lote NAO foi
          // processado → reenvio via SVC e seguro.
          providerResult = await this.reemitViaSvc(
            provider as any,
            payload as SefazEmitPayload,
            svcType,
            config.providerToken ?? "",
            nfeId,
            userId,
            decision.reason,
            providerResult,
          );
        } else if (decision.needsConsult && providerResult.chaveAcesso) {
          // Erro de rede/timeout: a NF-e PODE ter sido autorizada na origem e a
          // resposta se perdido. Consultar a chave ANTES de reenviar — reenvio
          // cego causaria DUPLA AUTORIZACAO (PRO-3/USE-1).
          await this.nfeRepo.addAuditLog(nfeId, userId, "CONTINGENCIA_CONSULTA", {
            motivo: decision.reason,
            chaveAcesso: providerResult.chaveAcesso,
          });
          const consulta = await (provider as any).consultar(
            providerResult.chaveAcesso,
            config.providerToken ?? "",
          );
          if (consulta.status === "autorizada") {
            // Ja autorizada na origem — NAO reenviar; seguir como autorizada.
            providerResult = {
              ...providerResult,
              success: true,
              status: "autorizada",
              protocolo: consulta.protocolo,
              dataAutorizacao: consulta.dataAutorizacao,
              codigoStatus: consulta.codigoStatus,
              xmlAutorizado: consulta.xmlAutorizado,
              mensagem: consulta.mensagem || providerResult.mensagem,
            };
          } else if (
            consulta.status === "rejeitada" &&
            consulta.codigoStatus === 217
          ) {
            // Confirmado "nao consta" na origem → seguro reenviar via SVC.
            providerResult = await this.reemitViaSvc(
              provider as any,
              payload as SefazEmitPayload,
              svcType,
              config.providerToken ?? "",
              nfeId,
              userId,
              "nao consta na origem apos timeout",
              providerResult,
            );
          } else {
            // Consulta inconclusiva / SEFAZ ainda inacessivel → NAO reenviar.
            // Mantem em SENDING para reconciliacao (cai no branch 'erro' abaixo).
            await this.nfeRepo.addAuditLog(nfeId, userId, "CONTINGENCIA_ADIADA", {
              motivo:
                "consulta inconclusiva apos timeout — emissao pendente de reconciliacao",
              consultaStatus: consulta.status,
              consultaCStat: consulta.codigoStatus,
            });
          }
        }
      }

      // ── 8. Tratar resultado ──
      if (providerResult.status === "processando") {
        // Reconcilia: SEFAZ direto consulta por recibo (103) ou por chave
        // (104-sem-protNFe / duplicidade). Focus faz poll por ref=nfeId.
        const consultaResult = isSefazDirect
          ? await this.pollSefazResult(provider as any, providerResult, config)
          : await this.pollForResult(
              provider as any,
              nfeId,
              config.providerToken ?? "",
              3,
              3000,
            );

        if (consultaResult.status === "autorizada") {
          return await this.handleAuthorized(
            nfeId,
            userId,
            numero,
            draft.serie,
            consultaResult.chaveAcesso ?? providerResult.chaveAcesso!,
            consultaResult.protocolo!,
            consultaResult.dataAutorizacao,
            provider as any,
            config,
            consultaResult.xmlAutorizado,
          );
        }

        if (consultaResult.status === "rejeitada") {
          return await this.handleRejected(
            nfeId,
            userId,
            numero,
            draft.serie,
            consultaResult.mensagem,
          );
        }

        // Ainda pendente — manter SENDING. NUNCA voltar para DRAFT apos envio.
        return this.pendingResult(
          nfeId,
          numero,
          draft.serie,
          providerResult,
          "NF-e enviada — aguardando processamento da SEFAZ (reconsultar)",
        );
      }

      if (providerResult.status === "autorizada") {
        return await this.handleAuthorized(
          nfeId,
          userId,
          numero,
          draft.serie,
          providerResult.chaveAcesso!,
          providerResult.protocolo!,
          providerResult.dataAutorizacao,
          provider as any,
          config,
          providerResult.xmlAutorizado,
        );
      }

      if (providerResult.status === "erro") {
        // Erro de rede/HTTP apos o envio: NAO sabemos se a SEFAZ autorizou.
        // NUNCA voltar para DRAFT (poderia reemitir uma NF-e ja autorizada).
        // Mantem SENDING para reconciliacao manual por consulta (USE-3).
        await this.nfeRepo.addAuditLog(nfeId, userId, "ENVIO_INCERTO", {
          mensagem: providerResult.mensagem,
          chaveAcesso: providerResult.chaveAcesso,
        });
        return this.pendingResult(
          nfeId,
          numero,
          draft.serie,
          providerResult,
          `Envio com falha de comunicacao — status indefinido, reconciliar por consulta: ${providerResult.mensagem}`,
        );
      }

      // Rejeitada (cStat de validacao)
      return await this.handleRejected(
        nfeId,
        userId,
        numero,
        draft.serie,
        providerResult.mensagem,
      );
    } catch (error) {
      // Rollback para DRAFT SOMENTE se ainda NAO enviamos a SEFAZ. Apos o
      // envio, a NF-e pode ter sido autorizada — reverter para DRAFT permitiria
      // reemitir e duplicar (USE-3). Nesse caso mantemos SENDING.
      if (!sentToSefaz) {
        await this.forceStatus(nfeId, "DRAFT");
        await this.nfeRepo.addAuditLog(nfeId, userId, "EDITADA_DRAFT", {
          motivo: "Erro antes do envio - retornado a rascunho",
          erro: error instanceof Error ? error.message : String(error),
        });
      } else {
        await this.nfeRepo.addAuditLog(nfeId, userId, "ENVIO_INCERTO", {
          motivo: "Erro apos envio - mantido em SENDING para reconciliacao",
          erro: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * Reenvia a NF-e via SVC de contingencia (nova chave/tpEmis) e registra a
   * trilha de auditoria. Persiste a nova chave gerada pelo SVC.
   */
  private async reemitViaSvc(
    provider: any,
    payload: SefazEmitPayload,
    svcType: "SVC_AN" | "SVC_RS",
    token: string,
    nfeId: string,
    userId: string,
    motivo: string,
    prev: any,
  ): Promise<any> {
    await this.nfeRepo.addAuditLog(nfeId, userId, "CONTINGENCIA_SVC", {
      svcType,
      motivo,
      cStatOrigem: prev?.codigoStatus,
      mensagemOrigem: prev?.mensagem,
    });
    const result = await provider.emitir({
      nfeData: { ...payload, contingencia: svcType },
      token,
      ref: nfeId,
    });
    await this.nfeRepo.addAuditLog(
      nfeId,
      userId,
      result.success ? "CONTINGENCIA_OK" : "CONTINGENCIA_FALHOU",
      {
        svcType,
        chaveAcesso: result.chaveAcesso,
        protocolo: result.protocolo,
        cStat: result.codigoStatus,
        mensagem: result.mensagem,
      },
    );
    if (result.chaveAcesso) {
      await (prisma as any).nfeEmitida.update({
        where: { id: nfeId },
        data: { chaveAcesso: result.chaveAcesso },
      });
    }
    return result;
  }

  /**
   * Polling de resultado para SEFAZ direto. Consulta por recibo (cStat 103) ou
   * por chave de acesso (104-sem-protNFe, duplicidade). NUNCA usa o nfeId
   * interno (PRO-1/USE-2).
   */
  private async pollSefazResult(
    provider: any,
    providerResult: any,
    config: CompanyFiscalConfig,
    maxAttempts = 3,
    delayMs = 3000,
  ): Promise<any> {
    const token = config.providerToken ?? "";
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      let consulta: any;
      if (
        providerResult.codigoStatus === 103 &&
        providerResult.protocolo &&
        typeof provider.consultarRecibo === "function"
      ) {
        consulta = await provider.consultarRecibo(
          providerResult.protocolo,
          providerResult.chaveAcesso ?? "",
        );
      } else if (providerResult.chaveAcesso) {
        consulta = await provider.consultar(providerResult.chaveAcesso, token);
      } else {
        return { status: "processando", mensagem: "Sem chave/recibo para consultar" };
      }
      if (consulta.status !== "processando") return consulta;
    }
    return { status: "processando", mensagem: "Ainda processando apos polling" };
  }

  private pendingResult(
    nfeId: string,
    numero: number,
    serie: number,
    providerResult: any,
    mensagem: string,
  ): EmissionResult {
    return {
      success: providerResult.status !== "erro",
      nfeId,
      status: "SENDING",
      numero,
      serie,
      chaveAcesso: providerResult.chaveAcesso ?? null,
      protocolo: providerResult.protocolo ?? null,
      mensagem,
    };
  }

  private validate(draft: NfeDraftResponse, config: CompanyFiscalConfig): void {
    if (!draft.itens || draft.itens.length === 0) {
      throw new Error("A nota deve ter ao menos 1 produto");
    }

    const dest = draft.destinatarioJson;
    if (!dest || !dest.cpfCnpj || !dest.nome) {
      throw new Error("Destinatario incompleto (CPF/CNPJ e nome obrigatorios)");
    }

    // Endereco do destinatario e OBRIGATORIO para NFe modelo 55 nacional
    // (so dispensavel para EXTERIOR). Validamos localmente para dar uma
    // mensagem clara em vez da rejeicao generica da SEFAZ "NF-e sem a
    // informacao de endereco do destinatario". O cMun (codigo IBGE 7 digitos)
    // costuma ser o campo faltante.
    if (dest.tipoPessoa !== "EXTERIOR") {
      const faltantes: string[] = [];
      if (!dest.logradouro) faltantes.push("logradouro");
      if (!dest.numero) faltantes.push("numero");
      if (!dest.bairro) faltantes.push("bairro");
      if (!dest.municipio) faltantes.push("municipio");
      if (!dest.codMunicipio) faltantes.push("codigo IBGE do municipio (cMun)");
      if (!dest.uf) faltantes.push("UF");
      if (!dest.cep) faltantes.push("CEP");
      if (faltantes.length > 0) {
        throw new Error(
          `Endereco do destinatario incompleto. Preencha no cadastro do cliente: ${faltantes.join(", ")}.`,
        );
      }
    }

    if (!draft.naturezaOperacao) {
      throw new Error("Natureza da operacao nao informada");
    }

    for (const item of draft.itens) {
      if (!item.ncm) throw new Error(`Item "${item.descricao}" sem NCM`);
      if (!item.cfop) throw new Error(`Item "${item.descricao}" sem CFOP`);
      if (Number(item.quantidade) <= 0)
        throw new Error(`Item "${item.descricao}" com quantidade invalida`);
      if (Number(item.valorUnitario) <= 0)
        throw new Error(`Item "${item.descricao}" com valor unitario invalido`);
    }

    if (!config.cnpj || !config.razaoSocial || !config.inscricaoEstadual) {
      throw new Error("Dados do emitente incompletos");
    }
    if (!config.uf || !config.municipio || !config.codMunicipio) {
      throw new Error("Endereco fiscal do emitente incompleto");
    }
  }

  private async handleAuthorized(
    nfeId: string,
    userId: string,
    numero: number,
    serie: number,
    chaveAcesso: string,
    protocolo: string,
    dataAutorizacao: Date | null,
    provider: any,
    config: CompanyFiscalConfig,
    xmlAutorizadoInline?: string | null,
  ): Promise<EmissionResult> {
    // Transition to AUTHORIZED
    await this.transitionStatus(nfeId, userId, "SENDING", "AUTHORIZED");

    // Fetch authorized XML — preferimos o XML inline retornado pelo provider
    // (caso SEFAZ direto, vem no payload de retorno). Como fallback, Focus
    // exige uma chamada extra via buscarXml(ref, token).
    let xmlAutorizadoPath: string | null = null;
    if (xmlAutorizadoInline) {
      xmlAutorizadoPath = await this.storage.saveXmlAutorizado(
        userId,
        nfeId,
        xmlAutorizadoInline,
      );
    } else if (provider.buscarXml) {
      const xml = await provider.buscarXml(nfeId, config.providerToken!);
      if (xml) {
        xmlAutorizadoPath = await this.storage.saveXmlAutorizado(userId, nfeId, xml);
      }
    }

    // NR-1: quando a autorizacao foi reconhecida via CONSULTA (timeout/
    // duplicidade reconciliados) o provedor devolve protocolo mas NAO o nfeProc
    // completo — entao o XML canonico autorizado fica ausente. NAO falhamos a
    // emissao (a NF-e esta autorizada), mas registramos para recuperacao
    // posterior (ex.: via NFeDistribuicaoDFe). Sem isso o gap passaria
    // silencioso (arquivamento/segunda-via do XML ficariam vazios).
    if (!xmlAutorizadoPath) {
      await this.nfeRepo.addAuditLog(nfeId, userId, "XML_AUTORIZADO_PENDENTE", {
        chaveAcesso,
        protocolo,
        motivo:
          "Autorizacao reconhecida sem nfeProc inline — recuperar XML autorizado posteriormente",
      });
    }

    // Generate DANFE PDF
    // Preferimos gerar a partir do XML autorizado (fonte canônica imutável
    // retornada pela SEFAZ). Fallback para o caminho DB quando XML inline
    // não está disponível (cenário Focus NFe, ou retorno parcial).
    let danfePdfPath: string | null = null;
    try {
      let pdfBytes: Uint8Array | null = null;
      if (xmlAutorizadoInline) {
        try {
          pdfBytes = await this.danfeService.generateFromXml(xmlAutorizadoInline);
        } catch {
          // Parse falhou — cai no fallback DB
          pdfBytes = null;
        }
      }
      if (!pdfBytes) {
        const nfeData = await this.loadNfe(nfeId);
        pdfBytes = await this.danfeService.generate(
          nfeData,
          config,
          chaveAcesso,
          protocolo,
        );
      }
      danfePdfPath = await this.storage.saveDanfePdf(userId, nfeId, pdfBytes);
    } catch {
      // DANFE generation is non-critical — log but don't fail
    }

    // Update NFe record
    await (prisma as any).nfeEmitida.update({
      where: { id: nfeId },
      data: {
        chaveAcesso,
        protocoloAutorizacao: protocolo,
        dataAutorizacao: dataAutorizacao ?? new Date(),
        xmlAutorizadoPath,
        danfePdfPath,
      },
    });

    await this.nfeRepo.addAuditLog(nfeId, userId, "AUTORIZADA", {
      chaveAcesso,
      protocolo,
    });

    return {
      success: true,
      nfeId,
      status: "AUTHORIZED",
      numero,
      serie,
      chaveAcesso,
      protocolo,
      mensagem: "NF-e autorizada com sucesso",
    };
  }

  private async handleRejected(
    nfeId: string,
    userId: string,
    numero: number,
    serie: number,
    mensagem: string,
  ): Promise<EmissionResult> {
    await this.forceStatus(nfeId, "REJECTED");

    await (prisma as any).nfeEmitida.update({
      where: { id: nfeId },
      data: { motivoRejeicao: mensagem },
    });

    await this.nfeRepo.addAuditLog(nfeId, userId, "REJEITADA", { mensagem });

    return {
      success: false,
      nfeId,
      status: "REJECTED",
      numero,
      serie,
      chaveAcesso: null,
      protocolo: null,
      mensagem,
    };
  }

  private async pollForResult(
    provider: any,
    ref: string,
    token: string,
    maxAttempts: number,
    delayMs: number,
  ): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = await provider.consultar(ref, token);
      if (result.status !== "processando") {
        return result;
      }
    }
    return { status: "processando", mensagem: "Ainda processando" };
  }

  private async transitionStatus(
    nfeId: string,
    userId: string,
    from: NfeStatus,
    to: NfeStatus,
  ): Promise<void> {
    if (!canTransition(from, to)) {
      throw new Error(`Transicao invalida: ${from} → ${to}`);
    }

    await (prisma as any).nfeEmitida.update({
      where: { id: nfeId },
      data: { status: to },
    });
  }

  private async forceStatus(nfeId: string, status: NfeStatus): Promise<void> {
    await (prisma as any).nfeEmitida.update({
      where: { id: nfeId },
      data: { status },
    });
  }

  private async loadNfe(nfeId: string): Promise<NfeDraftResponse> {
    const row = await (prisma as any).nfeEmitida.findUnique({
      where: { id: nfeId },
      include: { itens: { orderBy: { numero: "asc" } } },
    });
    if (!row) throw new Error("NF-e nao encontrada");

    return {
      id: row.id,
      userId: row.userId,
      orderId: row.orderId,
      customerId: row.customerId,
      ambiente: row.ambiente,
      modelo: row.modelo,
      serie: row.serie,
      numero: row.numero,
      chaveAcesso: row.chaveAcesso,
      tipoOperacao: row.tipoOperacao,
      finalidade: row.finalidade,
      destinoOperacao: row.destinoOperacao,
      naturezaOperacao: row.naturezaOperacao,
      indPresenca: row.indPresenca,
      intermediador: row.intermediador,
      numeroPedido: row.numeroPedido,
      dataEmissao: row.dataEmissao,
      dataSaida: row.dataSaida,
      destinatarioJson: row.destinatarioJson as any,
      emitenteJson: row.emitenteJson as any,
      modalidadeFrete: row.modalidadeFrete,
      transportadoraJson: row.transportadoraJson as any,
      totaisJson: row.totaisJson as any,
      notasReferenciadasJson: row.notasReferenciadasJson as any,
      exportacaoJson: row.exportacaoJson as any,
      pagamentosJson: row.pagamentosJson as any,
      duplicatasJson: row.duplicatasJson as any,
      volumesJson: row.volumesJson as any,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      itens: (row.itens ?? []).map((item: any) => ({
        id: item.id,
        productId: item.productId,
        numero: item.numero,
        codigo: item.codigo,
        descricao: item.descricao,
        ncm: item.ncm,
        cfop: item.cfop,
        cest: item.cest,
        origem: item.origem,
        unidade: item.unidade,
        quantidade: Number(item.quantidade),
        valorUnitario: Number(item.valorUnitario),
        valorTotal: Number(item.valorTotal),
        desconto: item.desconto != null ? Number(item.desconto) : null,
        observacoes: item.observacoes,
        tributosJson: item.tributosJson as any,
      })),
    };
  }

  private buildEmitenteSnapshot(config: CompanyFiscalConfig): any {
    return {
      cnpj: config.cnpj,
      razaoSocial: config.razaoSocial,
      nomeFantasia: config.nomeFantasia,
      inscricaoEstadual: config.inscricaoEstadual,
      regimeTributario: config.regimeTributario,
      logradouro: config.logradouro,
      numero: config.numero,
      bairro: config.bairro,
      municipio: config.municipio,
      codMunicipio: config.codMunicipio,
      uf: config.uf,
      cep: config.cep,
    };
  }
}

/**
 * Remove campos sensíveis do CompanyFiscalConfig antes de persistir como
 * snapshot do xmlOriginal (SEFAZ direto). Mantém o que é útil para auditoria,
 * mascara/elimina senhas e tokens.
 */
function redactConfig(config: CompanyFiscalConfig): Partial<CompanyFiscalConfig> {
  const { certificadoSenhaEnc, providerToken, ...rest } = config as any;
  void certificadoSenhaEnc;
  void providerToken;
  return rest;
}
