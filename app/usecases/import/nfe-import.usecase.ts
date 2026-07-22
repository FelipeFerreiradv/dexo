/**
 * Import de NF-e HISTÓRICAS (Vaapt/invoicy) — registra notas JÁ emitidas no
 * sistema antigo como histórico em `NfeEmitida`, SEM passar pela SEFAZ:
 *
 * - caminho de escrita dedicado (`NfeRepository.createHistoric`) — o
 *   pipeline real de emissão (`createDraft` → SEFAZ → AUTHORIZED) fica
 *   intocado;
 * - dedup por chave de acesso (@unique) e por (userId, ambiente, série,
 *   número) — preload + P2002 como skip;
 * - ao final AVANÇA `NfeSequence` por série via
 *   `NfeSequenceService.ajustarProximoNumero` (só avança, nunca retrocede)
 *   para a próxima emissão real continuar a numeração do cliente — sem
 *   isso, a próxima NF-e real colidiria com um número histórico;
 * - `customerId` fica NULO no v1 (o resumo não traz CPF/CNPJ; casar por
 *   nome seria chute). O import por XML autorizado — com itens e
 *   destinatário completos — é a fase seguinte.
 */

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  NfeRepository,
  type NfeHistoricCreate,
} from "../../repositories/nfe.repository";
import { NfeSequenceService } from "../../fiscal/sequence/nfe-sequence.service";
import { CompanyFiscalRepository } from "../../repositories/company-fiscal.repository";
import type { ImportContext, ImportReport } from "./import.types";
import {
  ImportValidationError,
  addIssue,
  addSample,
  bump,
  newReport,
} from "./import.types";
import { fileOfKind } from "./import-detector";
import { mapVaaptNfes, type NfePlanItem } from "./mappers/vaapt-nfes.mapper";
import { mapIbrNfes } from "./mappers/ibr-nfes.mapper";

/**
 * Notas históricas são sempre de PRODUÇÃO (foram emitidas de verdade no
 * sistema antigo). A chave de acesso não carrega tpAmb — constante aqui.
 */
const AMBIENTE = "PRODUCAO";

/**
 * A importação de histórico cria SEMPRE modelo 55 (`NfeRepository.createHistoric`
 * grava `modelo: "55"` fixo, e o avanço de sequência abaixo também passa "55").
 *
 * Isso importa para a idempotência: a numeração da NFC-e (65) é INDEPENDENTE da
 * NF-e (55) — o próprio schema diz isso e o índice
 * `(companyFiscalConfigId, ambiente, serie, numero, modelo)` inclui o modelo.
 * Série 4 / número 2 pode existir nos dois modelos sem colisão. Sem filtrar por
 * modelo, uma NFC-e emitida no PDV fazia a NF-e de mesma série/número ser
 * descartada como "já existia" — perda silenciosa na importação.
 */
const MODELO_HISTORICO = "55";

export interface NfeImportDeps {
  createHistoric: (data: NfeHistoricCreate) => Promise<{ id: string }>;
  loadExisting: (
    userId: string,
    ambiente: string,
  ) => Promise<
    Array<{ serie: number; numero: number; chaveAcesso: string | null }>
  >;
  ajustarProximoNumero: (
    userId: string,
    ambiente: string,
    serie: number,
    novoNumero: number,
  ) => Promise<void>;
}

const nfeRepository = new NfeRepository();
const nfeSequenceService = new NfeSequenceService();
const companyFiscalRepository = new CompanyFiscalRepository();

// Multi-CNPJ: notas históricas pertencem ao CNPJ PADRÃO do tenant — o
// carimbo na nota (unique parcial por emitente) e o avanço do contador têm
// que mirar a config padrão, nunca a de outro CNPJ do tenant. Cache por
// userId: o import roda em lote para um único tenant.
const defaultConfigIdCache = new Map<string, string | null>();
async function resolveDefaultConfigId(userId: string): Promise<string | null> {
  if (!defaultConfigIdCache.has(userId)) {
    const cfg = await companyFiscalRepository
      .findDefaultByUserId(userId)
      .catch(() => null);
    defaultConfigIdCache.set(userId, cfg?.id ?? null);
  }
  return defaultConfigIdCache.get(userId) ?? null;
}

export const defaultNfeImportDeps: NfeImportDeps = {
  createHistoric: async (data) => {
    const companyFiscalConfigId = await resolveDefaultConfigId(data.userId);
    return nfeRepository.createHistoric({
      ...data,
      ...(companyFiscalConfigId ? { companyFiscalConfigId } : {}),
    });
  },
  loadExisting: (userId, ambiente) =>
    prisma.nfeEmitida.findMany({
      // `modelo` no filtro: só NF-e 55 disputa série/número com o que este
      // import cria. Também reduz o egress — as NFC-e do PDV nem vêm.
      where: { userId, ambiente, modelo: MODELO_HISTORICO },
      select: { serie: true, numero: true, chaveAcesso: true },
    }),
  ajustarProximoNumero: async (userId, ambiente, serie, novoNumero) => {
    const companyFiscalConfigId = await resolveDefaultConfigId(userId);
    return nfeSequenceService.ajustarProximoNumero(
      userId,
      ambiente as never,
      serie,
      novoNumero,
      MODELO_HISTORICO,
      companyFiscalConfigId
        ? { companyFiscalConfigId, isDefaultConfig: true }
        : undefined,
    );
  },
};

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/** Runner VAAPT/NFE — resumo invoicy → registros históricos. */
export async function runVaaptNfes(
  ctx: ImportContext,
  deps: NfeImportDeps = defaultNfeImportDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "VAAPT_NFE");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo de notas emitidas (Vaapt) não encontrado.",
    );
  }
  const report = newReport("VAAPT", "NFE", ctx.targetUserId, ctx.dryRun);
  const mapped = mapVaaptNfes(file);
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "sem_numero", mapped.semNumero);
  bump(report, "numeros_distintos", mapped.items.length);
  bump(report, "reemissoes_colapsadas", mapped.duplicadosColapsados);
  bump(report, "sem_chave", mapped.semChave);
  for (const [status, n] of Object.entries(mapped.porStatus)) {
    bump(report, `status_${status.toLowerCase()}`, n);
  }
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }
  if (mapped.cnpjsEmitentes.length > 1) {
    bump(report, "avisos");
    addIssue(report.avisos, {
      motivo: `As chaves de acesso trazem ${mapped.cnpjsEmitentes.length} CNPJs emitentes distintos (${mapped.cnpjsEmitentes.join(", ")}) — confira se o arquivo é mesmo deste cliente`,
    });
  }

  await executeNfeHistoricPlan(ctx, report, mapped.items, deps);
  return report;
}

/**
 * Runner IBR/NFE — nfe_emitidas.csv (export tabular) → registros históricos.
 * Reaproveita 100% da execução do Vaapt (createHistoric + dedup + avanço de
 * sequência); só o mapper difere.
 */
export async function runIbrNfes(
  ctx: ImportContext,
  deps: NfeImportDeps = defaultNfeImportDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "IBR_NFE");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo de notas emitidas (IBR) não encontrado.",
    );
  }
  const report = newReport("IBR", "NFE", ctx.targetUserId, ctx.dryRun);
  const mapped = mapIbrNfes(file);
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "sem_numero", mapped.semNumero);
  bump(report, "numeros_distintos", mapped.items.length);
  bump(report, "reemissoes_colapsadas", mapped.duplicadosColapsados);
  bump(report, "sem_chave", mapped.semChave);
  for (const [status, n] of Object.entries(mapped.porStatus)) {
    bump(report, `status_${status.toLowerCase()}`, n);
  }
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }
  await executeNfeHistoricPlan(ctx, report, mapped.items, deps);
  return report;
}

/**
 * Execução histórica comum (Vaapt e IBR): preload de dedup, criação via
 * createHistoric e avanço da NfeSequence (só para frente, só por notas com
 * chave). Não altera o comportamento pré-existente do Vaapt — apenas foi
 * extraída para reuso.
 */
export async function executeNfeHistoricPlan(
  ctx: ImportContext,
  report: ImportReport,
  items: NfePlanItem[],
  deps: NfeImportDeps,
): Promise<void> {
  // Preload (idempotência): chaves e pares série/número já no tenant, SÓ do
  // modelo 55 (ver MODELO_HISTORICO). Filtrar por modelo não enfraquece a
  // guarda por chave de acesso: a chave carrega o modelo nas posições 21-22,
  // então uma chave de NFC-e nunca poderia colidir com a de uma NF-e.
  const existing = await deps.loadExisting(ctx.targetUserId, AMBIENTE);
  const chavesExistentes = new Set(
    existing.map((e) => e.chaveAcesso).filter((c): c is string => !!c),
  );
  const numerosExistentes = new Set(
    existing.map((e) => `${e.serie}/${e.numero}`),
  );

  let processadas = 0;
  for (const item of items) {
    processadas++;
    if (processadas % 50 === 0 || processadas === items.length) {
      ctx.onProgress?.({
        fase: "nfe",
        processadas,
        total: items.length,
      });
    }

    if (
      (item.chaveAcesso && chavesExistentes.has(item.chaveAcesso)) ||
      numerosExistentes.has(`${item.serie}/${item.numero}`)
    ) {
      bump(report, "ja_existiam");
      continue;
    }

    if (ctx.dryRun) {
      bump(report, "a_criar");
      addSample(report, {
        numero: item.numero,
        serie: item.serie,
        status: item.status,
        valor: item.valor,
        destinatario: item.nomeDestinatario,
      });
      continue;
    }

    try {
      await deps.createHistoric({
        userId: ctx.targetUserId,
        ambiente: AMBIENTE,
        serie: item.serie,
        numero: item.numero,
        chaveAcesso: item.chaveAcesso,
        tipoOperacao: item.tipoOperacao,
        finalidade: "NORMAL",
        destinoOperacao: item.destinoOperacao,
        naturezaOperacao: item.naturezaOperacao,
        indPresenca: "9",
        informacoesComplementares: item.informacoesComplementares,
        dataEmissao: item.dataEmissao,
        dataAutorizacao: item.dataAutorizacao,
        // Shapes exatos que nfe-listing lê (destinatário sem documento — o
        // resumo não traz; customerId propositalmente nulo no v1).
        destinatarioJson: {
          tipoPessoa: "PJ",
          cpfCnpj: "",
          nome: item.nomeDestinatario,
        },
        emitenteJson: item.cnpjEmitente ? { cnpj: item.cnpjEmitente } : null,
        totaisJson: {
          totalNota: item.valor,
          totalProdutos: item.valor,
          totalIcms: 0,
          totalPis: 0,
          totalCofins: 0,
          totalDesconto: 0,
          totalFrete: 0,
        },
        status: item.status,
      });
      bump(report, "criadas");
      numerosExistentes.add(`${item.serie}/${item.numero}`);
      if (item.chaveAcesso) chavesExistentes.add(item.chaveAcesso);
    } catch (err) {
      if (isUniqueViolation(err)) {
        bump(report, "ja_existiam");
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `NF-e ${item.numero} (série ${item.serie}): ${msg}`,
      });
    }
  }

  // Avança a sequência por série (max importado + 1) — SÓ para frente. A
  // próxima emissão real do cliente continua a numeração; se a sequência já
  // está à frente, o serviço rejeita e contabilizamos como no-op.
  //
  // GUARDA: nota SEM chave tem a série ASSUMIDA (=1) — um chute não pode
  // avançar a NfeSequence (o avanço é irreversível: ajustarProximoNumero
  // nunca retrocede, e um pulo indevido cria gap fiscal na numeração real).
  // Só notas com chave (série extraída da própria chave) entram no cálculo.
  const maxPorSerie = new Map<number, number>();
  let semChaveForaDaSequencia = 0;
  for (const item of items) {
    if (!item.chaveAcesso) {
      semChaveForaDaSequencia++;
      continue;
    }
    maxPorSerie.set(
      item.serie,
      Math.max(maxPorSerie.get(item.serie) ?? 0, item.numero),
    );
  }
  if (semChaveForaDaSequencia > 0) {
    bump(report, "avisos");
    addIssue(report.avisos, {
      motivo: `${semChaveForaDaSequencia} nota(s) sem chave de acesso foram importadas com série assumida = 1 e NÃO avançam a NfeSequence (a série real não é verificável sem a chave)`,
    });
  }
  for (const [serie, maxNumero] of maxPorSerie) {
    const alvo = maxNumero + 1;
    if (ctx.dryRun) {
      bump(report, "avisos");
      addIssue(report.avisos, {
        motivo: `NfeSequence série ${serie}: será ajustada para ${alvo} (se estiver atrás)`,
      });
      continue;
    }
    try {
      await deps.ajustarProximoNumero(ctx.targetUserId, AMBIENTE, serie, alvo);
      bump(report, "sequencias_ajustadas");
      bump(report, "avisos");
      addIssue(report.avisos, {
        motivo: `NfeSequence série ${serie} (${AMBIENTE}) ajustada para ${alvo}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/deve ser maior/i.test(msg)) {
        bump(report, "sequencias_ja_a_frente");
        continue;
      }
      bump(report, "erros");
      addIssue(report.erros, {
        motivo: `NfeSequence série ${serie}: ${msg}`,
      });
    }
  }
}
