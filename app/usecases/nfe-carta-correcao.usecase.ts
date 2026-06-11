import prisma from "../lib/prisma";
import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { createNfeProviderFromConfig } from "../fiscal/providers/provider-factory";
import type { FiscalAmbiente } from "../fiscal/domain/nfe.types";

export interface CartaCorrecaoResult {
  success: boolean;
  nfeId: string;
  /** Sequência usada (1..20). */
  sequencia: number;
  protocolo: string | null;
  cStat: number | null;
  mensagem: string;
}

/**
 * Envio de Carta de Correção Eletrônica (CCe) — evento 110110.
 *
 * Regras SEFAZ:
 *  - Nota precisa estar AUTORIZADA (status AUTHORIZED).
 *  - Texto da correção: 15..1000 caracteres, sem caracteres especiais (a UI
 *    deve sanitizar antes; aqui só validamos tamanho).
 *  - Até 20 CCes por nota — a sequência é incremental.
 *  - Não pode corrigir: base de cálculo, alíquota, valor, quantidade, mudança
 *    de remetente/destinatário, ou data de emissão/saída. (Regra de negócio
 *    do contador — não validamos isso aqui; depende de quem digita.)
 *
 * **Provider:** apenas SEFAZ_DIRECT suporta CCe via API. FocusNFe não expõe.
 * Use cases que recebem providerName=FOCUS_NFE devem rejeitar com mensagem
 * clara.
 */
export class NfeCartaCorrecaoUseCase {
  private nfeRepo: NfeRepository;
  private configRepo: CompanyFiscalRepository;

  constructor() {
    this.nfeRepo = new NfeRepository();
    this.configRepo = new CompanyFiscalRepository();
  }

  async execute(
    userId: string,
    nfeId: string,
    correcao: string,
  ): Promise<CartaCorrecaoResult> {
    // 1. Validar texto
    if (!correcao || correcao.trim().length < 15 || correcao.trim().length > 1000) {
      throw new Error("Texto da correcao deve ter 15..1000 caracteres");
    }
    const correcaoTrimmed = correcao.trim();

    // 2. Carregar NFe
    const nfe = await (prisma as any).nfeEmitida.findFirst({
      where: { id: nfeId, userId },
    });
    if (!nfe) throw new Error("NFe nao encontrada");
    if (nfe.status !== "AUTHORIZED") {
      throw new Error(
        `Somente NFes AUTORIZADAS podem receber CCe (status atual: ${nfe.status})`,
      );
    }
    if (!nfe.chaveAcesso) {
      throw new Error("NFe sem chave de acesso — nao e possivel enviar CCe");
    }

    // 3. Determinar próxima sequência (count + 1, máx 20).
    // Contamos apenas CCes EFETIVAMENTE REGISTRADAS na SEFAZ (evento
    // CCE_REGISTRADA), nao todas as tentativas. Uma CCe que falhou (rede,
    // rejeicao) NAO deve queimar um numero de sequencia — senao o cliente
    // nunca consegue registrar (nSeqEvento com buraco gera rejeicao 573) e
    // atinge o teto de 20 prematuramente (USE-5).
    const registradas = await (prisma as any).nfeAuditLog.count({
      where: { nfeId, evento: "CCE_REGISTRADA" },
    });
    const sequencia = registradas + 1;
    if (sequencia > 20) {
      throw new Error(
        "Limite de 20 Cartas de Correcao por NFe atingido (regra SEFAZ)",
      );
    }

    // 4. Carregar config
    const config = await this.configRepo.findByUserId(userId);
    if (!config) throw new Error("Configuracao fiscal nao encontrada");
    if (config.providerName !== "SEFAZ_DIRECT") {
      throw new Error(
        "Carta de Correcao via API e suportada apenas pelo provedor SEFAZ_DIRECT. " +
          "Configure o provedor em /notas-fiscais/configuracao.",
      );
    }
    if (!config.uf || !config.certificadoPath || !config.certificadoSenhaEnc) {
      throw new Error(
        "Provedor SEFAZ_DIRECT exige UF + certificado A1 configurados",
      );
    }

    // 5. Instanciar provider
    const provider = await createNfeProviderFromConfig({
      providerName: "SEFAZ_DIRECT",
      ambiente: config.ambiente as FiscalAmbiente,
      uf: config.uf,
      certificadoPath: config.certificadoPath,
      certificadoSenhaEnc: config.certificadoSenhaEnc,
    });

    if (!provider.cartaCorrecao) {
      throw new Error(
        "Provedor instanciado nao implementa cartaCorrecao — inconsistencia interna",
      );
    }

    // 6. Chamar provider
    const result = await provider.cartaCorrecao({
      chaveAcesso: nfe.chaveAcesso,
      correcao: correcaoTrimmed,
      sequencia,
    });

    // 7. Audit log — CCE_ENVIADA registra TODA tentativa (sucesso ou falha).
    await this.nfeRepo.addAuditLog(nfeId, userId, "CCE_ENVIADA", {
      sequencia,
      success: result.success,
      cStat: result.cStat,
      protocolo: result.protocolo,
      mensagem: result.mensagem,
      correcao: correcaoTrimmed,
    });
    // CCE_REGISTRADA so quando ACEITA pela SEFAZ — e a base da contagem de
    // sequencia. Falhas nao consomem numero de sequencia.
    if (result.success) {
      await this.nfeRepo.addAuditLog(nfeId, userId, "CCE_REGISTRADA", {
        sequencia,
        cStat: result.cStat,
        protocolo: result.protocolo,
      });
    }

    return {
      success: result.success,
      nfeId,
      sequencia,
      protocolo: result.protocolo,
      cStat: result.cStat,
      mensagem: result.mensagem,
    };
  }
}
