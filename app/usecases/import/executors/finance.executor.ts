/**
 * Executor de CONTAS a pagar/receber — cria via `FinanceUseCase.create`
 * (customerId obrigatório, totalAmount > 0, paymentMethod validado, FIADO
 * só receivable). PROIBIÇÃO ESTRUTURAL: este executor só conhece `create`
 * — `markPaid` NUNCA entra aqui (dispararia baixa de estoque + sync de
 * marketplace + reconciliação de sucata); conta histórica paga entra com
 * `status: "PAGA"` + `paidAt` direto no create, que não tem efeitos
 * colaterais (finance.repository grava e pronto).
 *
 * Cliente: casado por CPF/CNPJ (prioridade) ou nome EXATO (normalizado).
 * Não encontrado ⇒ erro de linha — a importação NUNCA cria cliente
 * silenciosamente (importe Clientes antes; auditável).
 */

import prisma from "../../../lib/prisma";
import { FinanceUseCase } from "../../finance.usecase";
import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  addIssue,
  addSample,
  bump,
  newReport,
} from "../import.types";
import { normName } from "../lib/normalize";
import { parseFinanceMarker } from "../lib/markers";
import { fileOfKind } from "../import-detector";
import { mapContas } from "../mappers/contas.mapper";
import type { FinancePlanItem } from "../mappers/contas.mapper";

export interface FinanceCustomerRef {
  id: string;
  name: string | null;
  cpf: string | null;
  cnpj: string | null;
}

export interface FinanceExecDeps {
  /** SÓ o create — markPaid não existe neste contrato de propósito. */
  financeUseCase: Pick<FinanceUseCase, "create">;
  loadCustomers: (userId: string) => Promise<FinanceCustomerRef[]>;
  /** Markers "[import xxxxxxxx]" já gravados (receivables + payables). */
  loadExistingMarkers: (userId: string) => Promise<string[]>;
}

export const defaultFinanceDeps: FinanceExecDeps = {
  financeUseCase: new FinanceUseCase(),
  loadCustomers: (userId) =>
    prisma.customer.findMany({
      where: { userId },
      select: { id: true, name: true, cpf: true, cnpj: true },
    }),
  loadExistingMarkers: async (userId) => {
    const [receivables, payables] = await Promise.all([
      prisma.receivable.findMany({
        where: { userId, reason: { contains: "[import " } },
        select: { reason: true },
      }),
      prisma.payable.findMany({
        where: { userId, reason: { contains: "[import " } },
        select: { reason: true },
      }),
    ]);
    return [...receivables, ...payables]
      .map((r) => parseFinanceMarker(r.reason))
      .filter((h): h is string => !!h);
  },
};

export async function executeFinancePlan(
  ctx: ImportContext,
  report: ImportReport,
  items: FinancePlanItem[],
  deps: FinanceExecDeps = defaultFinanceDeps,
): Promise<void> {
  const customers = await deps.loadCustomers(ctx.targetUserId);
  const byCpf = new Map<string, FinanceCustomerRef>();
  const byCnpj = new Map<string, FinanceCustomerRef>();
  const byName = new Map<string, FinanceCustomerRef[]>();
  for (const c of customers) {
    if (c.cpf) byCpf.set(c.cpf, c);
    if (c.cnpj) byCnpj.set(c.cnpj, c);
    if (c.name) {
      const key = normName(c.name);
      const arr = byName.get(key) ?? [];
      arr.push(c);
      byName.set(key, arr);
    }
  }
  const existingMarkers = new Set(
    await deps.loadExistingMarkers(ctx.targetUserId),
  );

  let processadas = 0;
  for (const item of items) {
    processadas++;
    if (processadas % 50 === 0 || processadas === items.length) {
      ctx.onProgress?.({ fase: "contas", processadas, total: items.length });
    }

    if (existingMarkers.has(item.markerHash)) {
      bump(report, "ja_existiam_marker");
      continue;
    }

    // Casamento do cliente: documento primeiro, nome exato como fallback.
    let customer: FinanceCustomerRef | null = null;
    if (item.customerCpf) customer = byCpf.get(item.customerCpf) ?? null;
    if (!customer && item.customerCnpj) {
      customer = byCnpj.get(item.customerCnpj) ?? null;
    }
    if (!customer && item.customerName) {
      const candidates = byName.get(normName(item.customerName)) ?? [];
      if (candidates.length > 1) {
        bump(report, "cliente_ambiguo");
        bump(report, "erros");
        addIssue(report.erros, {
          linha: item.linha,
          motivo: `Cliente "${item.customerName}": ${candidates.length} clientes com esse nome — informe o CPF/CNPJ na planilha`,
        });
        continue;
      }
      customer = candidates[0] ?? null;
    }
    if (!customer) {
      bump(report, "cliente_nao_encontrado");
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `Cliente não encontrado (${item.customerCpf ?? item.customerCnpj ?? item.customerName}) — importe os Clientes antes das contas`,
      });
      continue;
    }

    if (ctx.dryRun) {
      bump(report, "a_criar");
      bump(report, item.kind === "receivable" ? "a_receber" : "a_pagar");
      addSample(report, {
        tipo: item.kind === "receivable" ? "receber" : "pagar",
        cliente: customer.name,
        valor: item.totalAmount,
        vencimento: item.dueDate.toISOString().slice(0, 10),
        status: item.status,
      });
      continue;
    }

    try {
      await deps.financeUseCase.create(item.kind, {
        userId: ctx.targetUserId,
        customerId: customer.id,
        document: item.document ?? null,
        reason: item.reason,
        totalAmount: item.totalAmount,
        dueDate: item.dueDate,
        installments: item.installments,
        status: item.status,
        // Histórica paga: status+paidAt DIRETO no create (zero efeitos
        // colaterais). markPaid é proibido no motor.
        paidAt: item.paidAt ?? null,
        paymentMethod: item.paymentMethod ?? null,
      });
      bump(report, "criadas");
      bump(report, item.kind === "receivable" ? "a_receber" : "a_pagar");
      existingMarkers.add(item.markerHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `Conta (${customer.name}, R$ ${item.totalAmount}): ${msg}`,
      });
    }
  }

  ctx.onProgress?.({
    fase: "contas",
    processadas: items.length,
    total: items.length,
  });
}

/** Runner DEXO/CONTAS — template CSV próprio. */
export async function runContas(
  ctx: ImportContext,
  deps: FinanceExecDeps = defaultFinanceDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "DEXO_CONTAS");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo de contas (template Dexo) não encontrado.",
    );
  }
  const report = newReport("DEXO", "CONTAS", ctx.targetUserId, ctx.dryRun);
  const mapped = mapContas(file);
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  for (const erro of mapped.erros) {
    bump(report, "erros");
    addIssue(report.erros, erro);
  }
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }
  await executeFinancePlan(ctx, report, mapped.items, deps);
  return report;
}
