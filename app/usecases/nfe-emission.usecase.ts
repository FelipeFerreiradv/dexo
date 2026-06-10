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

    // ── Transition: DRAFT → VALIDATING ──
    await this.transitionStatus(nfeId, userId, "DRAFT", "VALIDATING");

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

      let providerResult = await provider.emitir({
        nfeData: payload,
        token: config.providerToken ?? "",
        ref: nfeId,
      });

      // ── 7a. Auto-fallback para SVC (contingência) ──
      // Só dispara para SEFAZ direto, com auto-fallback habilitado via env,
      // e quando o resultado indica problema de infra (cStat 108/109/280+,
      // timeout, ECONNRESET, HTTP 5xx persistente). Rejeições "comuns" (XML
      // inválido, etc.) NÃO são retentadas via SVC.
      if (isSefazDirect && isAutoFallbackEnabled() && config.uf) {
        const decision = shouldFallbackToSvc(providerResult);
        if (decision.shouldFallback) {
          const svcType = getSvcType(config.uf as UF);
          await this.nfeRepo.addAuditLog(nfeId, userId, "CONTINGENCIA_SVC", {
            svcType,
            motivo: decision.reason,
            cStatOrigem: providerResult.codigoStatus,
            mensagemOrigem: providerResult.mensagem,
          });

          // Reenvia com mesmo numero/serie mas tpEmis ajustado.
          // O builder vai gerar nova chave (cDV recalculado) e novo XML
          // assinado — totalmente independente da tentativa anterior.
          const sefazPayload = payload as SefazEmitPayload;
          providerResult = await provider.emitir({
            nfeData: { ...sefazPayload, contingencia: svcType },
            token: config.providerToken ?? "",
            ref: nfeId,
          });

          if (providerResult.success) {
            await this.nfeRepo.addAuditLog(nfeId, userId, "CONTINGENCIA_OK", {
              svcType,
              chaveAcesso: providerResult.chaveAcesso,
              protocolo: providerResult.protocolo,
            });
          } else {
            await this.nfeRepo.addAuditLog(nfeId, userId, "CONTINGENCIA_FALHOU", {
              svcType,
              cStat: providerResult.codigoStatus,
              mensagem: providerResult.mensagem,
            });
          }
        }
      }

      // ── 8. Handle result ──
      if (providerResult.status === "processando") {
        // Focus NFe processes async — poll for result
        const consultaResult = await this.pollForResult(
          provider as any,
          nfeId,
          config.providerToken,
          3,  // max attempts
          3000, // delay ms
        );

        if (consultaResult.status === "autorizada") {
          return await this.handleAuthorized(
            nfeId,
            userId,
            numero,
            draft.serie,
            consultaResult.chaveAcesso!,
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

        // Still processing — mark as authorized-pending
        // The user can check status later
        await (prisma as any).nfeEmitida.update({
          where: { id: nfeId },
          data: {
            chaveAcesso: providerResult.chaveAcesso,
            protocoloAutorizacao: providerResult.protocolo,
          },
        });

        return {
          success: true,
          nfeId,
          status: "SENDING",
          numero,
          serie: draft.serie,
          chaveAcesso: providerResult.chaveAcesso,
          protocolo: providerResult.protocolo,
          mensagem: "NF-e enviada, aguardando autorizacao da SEFAZ",
        };
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

      // Rejected
      return await this.handleRejected(
        nfeId,
        userId,
        numero,
        draft.serie,
        providerResult.mensagem,
      );
    } catch (error) {
      // Rollback to DRAFT on any unexpected error
      await this.forceStatus(nfeId, "DRAFT");
      await this.nfeRepo.addAuditLog(nfeId, userId, "EDITADA_DRAFT", {
        motivo: "Erro na emissao - retornado a rascunho",
        erro: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private validate(draft: NfeDraftResponse, config: CompanyFiscalConfig): void {
    if (!draft.itens || draft.itens.length === 0) {
      throw new Error("A nota deve ter ao menos 1 produto");
    }

    const dest = draft.destinatarioJson;
    if (!dest || !dest.cpfCnpj || !dest.nome) {
      throw new Error("Destinatario incompleto (CPF/CNPJ e nome obrigatorios)");
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

    // Generate DANFE PDF
    let danfePdfPath: string | null = null;
    try {
      const nfeData = await this.loadNfe(nfeId);
      const pdfBytes = await this.danfeService.generate(
        nfeData,
        config,
        chaveAcesso,
        protocolo,
      );
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
