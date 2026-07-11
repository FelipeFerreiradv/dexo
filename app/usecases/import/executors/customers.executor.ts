/**
 * Executor de CLIENTES — cria via `CustomerUseCase.create` (validação de
 * nome, unicidade de CPF/CNPJ por tipo de pessoa). Dedup por PRELOAD único
 * em memória (padrão do phase2Customers de migracao-vaapt.ts), em camadas:
 *
 * 1. marker de código legado em notes (novo "Import Dexo · cliente #N" e
 *    legado "Legado <TENANT> · cliente #N") — idempotência mesmo sem doc;
 * 2. CPF / CNPJ (CNPJ NÃO tem unique no banco e o usecase só o checa para
 *    PJ → o preload é obrigatório aqui);
 * 3. heurística nome+telefone para clientes sem documento.
 *
 * "Já existe um cliente com esse CPF/CNPJ" vindo do usecase = corrida
 * benigna ⇒ skip contabilizado, nunca erro.
 */

import prisma from "../../../lib/prisma";
import { CustomerUseCase } from "../../customer.usecase";
import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  addIssue,
  addSample,
  bump,
  newReport,
} from "../import.types";
import { normName, onlyDigits } from "../lib/normalize";
import { parseCustomerMarker } from "../lib/markers";
import { fileOfKind } from "../import-detector";
import { mapVaaptCustomers } from "../mappers/vaapt-clientes.mapper";
import { mapWdCustomers } from "../mappers/wd-clientes.mapper";
import type {
  CustomerPlanItem,
  CustomersMapResult,
} from "../mappers/vaapt-clientes.mapper";

export interface ExistingCustomerRef {
  cpf: string | null;
  cnpj: string | null;
  name: string | null;
  phone: string | null;
  notes: string | null;
}

export interface CustomersExecDeps {
  customerUseCase: Pick<CustomerUseCase, "create">;
  loadExistingCustomers: (userId: string) => Promise<ExistingCustomerRef[]>;
}

export const defaultCustomersDeps: CustomersExecDeps = {
  customerUseCase: new CustomerUseCase(),
  loadExistingCustomers: (userId) =>
    prisma.customer.findMany({
      where: { userId },
      select: { cpf: true, cnpj: true, name: true, phone: true, notes: true },
    }),
};

export async function executeCustomersPlan(
  ctx: ImportContext,
  report: ImportReport,
  items: CustomerPlanItem[],
  deps: CustomersExecDeps = defaultCustomersDeps,
): Promise<void> {
  const existing = await deps.loadExistingCustomers(ctx.targetUserId);
  const exCpf = new Set(existing.map((c) => c.cpf).filter((v): v is string => !!v));
  const exCnpj = new Set(
    existing.map((c) => c.cnpj).filter((v): v is string => !!v),
  );
  const exNamePhone = new Set(
    existing
      .filter((c) => c.name && c.phone)
      .map((c) => `${normName(c.name as string)}|${onlyDigits(c.phone)}`),
  );
  const exLegacyCod = new Set<string>();
  for (const c of existing) {
    const cod = parseCustomerMarker(c.notes);
    if (cod) exLegacyCod.add(cod);
  }

  let processadas = 0;
  for (const item of items) {
    processadas++;
    if (processadas % 100 === 0 || processadas === items.length) {
      ctx.onProgress?.({ fase: "clientes", processadas, total: items.length });
    }

    // Dedup em camadas contra o banco (tudo em memória, zero query por linha).
    if (item.cod && exLegacyCod.has(item.cod)) {
      bump(report, "ja_existiam_marker");
      continue;
    }
    if (item.cpf && exCpf.has(item.cpf)) {
      bump(report, "ja_existiam_cpf");
      continue;
    }
    if (!item.cpf && item.cnpj && exCnpj.has(item.cnpj)) {
      bump(report, "ja_existiam_cnpj");
      continue;
    }
    if (!item.cpf && !item.cnpj && item.phone) {
      if (exNamePhone.has(`${normName(item.name)}|${item.phone}`)) {
        bump(report, "ja_existiam_nome_telefone");
        continue;
      }
    }

    if (ctx.dryRun) {
      bump(report, "a_criar");
      addSample(report, {
        nome: item.name,
        tipo: item.personType,
        cpf: item.cpf,
        cnpj: item.cnpj,
        cidade: item.city ?? null,
      });
      continue;
    }

    try {
      await deps.customerUseCase.create({
        userId: ctx.targetUserId,
        personType: item.personType,
        name: item.name,
        razaoSocial: item.personType === "PJ" ? item.name : null,
        cpf: item.cpf,
        cnpj: item.cnpj,
        rg: item.rg ?? null,
        inscricaoEstadual: item.inscricaoEstadual ?? null,
        indicadorIE: item.indicadorIE ?? null,
        nomeFantasia: item.nomeFantasia ?? null,
        email: item.email ?? null,
        phone: item.phone ?? null,
        mobile: item.mobile ?? null,
        cep: item.cep ?? null,
        street: item.street ?? null,
        number: item.number ?? null,
        complement: item.complement ?? null,
        neighborhood: item.neighborhood ?? null,
        city: item.city ?? null,
        state: item.state ?? null,
        notes: item.notes,
      });
      bump(report, "criados");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/já existe/i.test(msg)) {
        bump(report, "ja_existiam_corrida");
        continue;
      }
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `Cliente "${item.name}": ${msg}`,
      });
    }

    // Mantém os sets coerentes dentro da mesma execução.
    if (item.cod) exLegacyCod.add(item.cod);
    if (item.cpf) exCpf.add(item.cpf);
    if (item.cnpj) exCnpj.add(item.cnpj);
    if (item.phone) {
      exNamePhone.add(`${normName(item.name)}|${item.phone}`);
    }
  }

  ctx.onProgress?.({
    fase: "clientes",
    processadas: items.length,
    total: items.length,
  });
}

function applyMapCounters(report: ImportReport, mapped: CustomersMapResult): void {
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "clientes_validos", mapped.items.length);
  bump(report, "placeholders_descartados", mapped.skippedPlaceholder);
  bump(report, "duplicados_na_planilha", mapped.skippedDuplicateInSheet);
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }
}

/** Runner VAAPT/CLIENTES. */
export async function runVaaptCustomers(
  ctx: ImportContext,
  deps: CustomersExecDeps = defaultCustomersDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "VAAPT_CLIENTES");
  if (!file) {
    throw new ImportValidationError("Arquivo de clientes (Vaapt) não encontrado.");
  }
  const report = newReport("VAAPT", "CLIENTES", ctx.targetUserId, ctx.dryRun);
  const mapped = mapVaaptCustomers(file);
  applyMapCounters(report, mapped);
  await executeCustomersPlan(ctx, report, mapped.items, deps);
  return report;
}

/** Runner WEBDESMONTE/CLIENTES (customers.csv — ex.: pacote Ribeiro). */
export async function runWdCustomers(
  ctx: ImportContext,
  deps: CustomersExecDeps = defaultCustomersDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "WD_CUSTOMERS");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo customers.csv (WebDesmonte) não encontrado.",
    );
  }
  const report = newReport(
    "WEBDESMONTE",
    "CLIENTES",
    ctx.targetUserId,
    ctx.dryRun,
  );
  const mapped = mapWdCustomers(file);
  applyMapCounters(report, mapped);
  await executeCustomersPlan(ctx, report, mapped.items, deps);
  return report;
}
