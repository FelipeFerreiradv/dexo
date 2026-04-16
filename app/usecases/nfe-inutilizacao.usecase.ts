import prisma from "../lib/prisma";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { NfeRepository } from "../repositories/nfe.repository";
import { createNfeProvider } from "../fiscal/providers/provider-factory";
import type { FiscalAmbiente } from "../fiscal/domain/nfe.types";

export interface InutilizacaoInput {
  serie: number;
  numeroInicial: number;
  numeroFinal: number;
  justificativa: string;
}

export interface InutilizacaoResult {
  success: boolean;
  id: string;
  status: "ACEITA" | "REJEITADA";
  protocolo: string | null;
  mensagem: string;
}

export interface InutilizacaoListItem {
  id: string;
  ambiente: string;
  serie: number;
  numeroInicial: number;
  numeroFinal: number;
  justificativa: string;
  protocolo: string | null;
  status: string;
  createdAt: string;
}

/**
 * Inutilização de faixa de numeração de NF-e.
 *
 * Regras SEFAZ:
 *  - Justificativa obrigatória (min 15 caracteres)
 *  - Número inicial ≤ número final
 *  - Série e números devem ser positivos
 */
export class NfeInutilizacaoUseCase {
  private configRepo: CompanyFiscalRepository;
  private nfeRepo: NfeRepository;

  constructor() {
    this.configRepo = new CompanyFiscalRepository();
    this.nfeRepo = new NfeRepository();
  }

  async inutilizar(
    userId: string,
    input: InutilizacaoInput,
  ): Promise<InutilizacaoResult> {
    // ── 1. Validate input ──
    if (!input.justificativa || input.justificativa.trim().length < 15) {
      throw new Error("Justificativa obrigatoria (minimo 15 caracteres)");
    }
    if (input.serie < 1) {
      throw new Error("Serie deve ser maior que zero");
    }
    if (input.numeroInicial < 1 || input.numeroFinal < 1) {
      throw new Error("Numeros devem ser maiores que zero");
    }
    if (input.numeroInicial > input.numeroFinal) {
      throw new Error("Numero inicial deve ser menor ou igual ao numero final");
    }

    // ── 2. Load config ──
    const config = await this.configRepo.findByUserId(userId);
    if (!config) {
      throw new Error("Configuracao fiscal nao encontrada");
    }
    if (!config.providerToken) {
      throw new Error("Token do provedor fiscal nao configurado");
    }
    if (!config.cnpj) {
      throw new Error("CNPJ do emitente nao configurado");
    }

    const ambiente = (config.ambiente as FiscalAmbiente).toLowerCase() as
      | "homologacao"
      | "producao";

    // ── 3. Create record (PENDENTE) ──
    const record = await (prisma as any).nfeInutilizacao.create({
      data: {
        userId,
        ambiente: config.ambiente,
        serie: input.serie,
        numeroInicial: input.numeroInicial,
        numeroFinal: input.numeroFinal,
        justificativa: input.justificativa.trim(),
        status: "PENDENTE",
      },
    });

    // ── 4. Call provider ──
    const provider = createNfeProvider(config.providerName, config.ambiente as FiscalAmbiente);
    const result = await provider.inutilizar({
      cnpj: config.cnpj.replace(/\D/g, ""),
      serie: input.serie,
      numeroInicial: input.numeroInicial,
      numeroFinal: input.numeroFinal,
      justificativa: input.justificativa.trim(),
      token: config.providerToken,
      ambiente,
    });

    // ── 5. Update record ──
    const status = result.success ? "ACEITA" : "REJEITADA";
    await (prisma as any).nfeInutilizacao.update({
      where: { id: record.id },
      data: {
        status,
        protocolo: result.protocolo,
        respostaJson: {
          mensagem: result.mensagem,
          protocolo: result.protocolo,
        },
      },
    });

    return {
      success: result.success,
      id: record.id,
      status,
      protocolo: result.protocolo,
      mensagem: result.mensagem || (result.success ? "Inutilizacao aceita" : "Inutilizacao rejeitada"),
    };
  }

  async list(userId: string): Promise<InutilizacaoListItem[]> {
    const rows = await (prisma as any).nfeInutilizacao.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return rows.map((r: any) => ({
      id: r.id,
      ambiente: r.ambiente,
      serie: r.serie,
      numeroInicial: r.numeroInicial,
      numeroFinal: r.numeroFinal,
      justificativa: r.justificativa,
      protocolo: r.protocolo,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
