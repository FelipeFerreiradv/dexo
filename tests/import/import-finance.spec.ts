import { describe, it, expect, vi } from "vitest";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    customer: { findMany: vi.fn(async () => []) },
    receivable: { findMany: vi.fn(async () => []) },
    payable: { findMany: vi.fn(async () => []) },
  },
}));

import { mapContas } from "../../app/usecases/import/mappers/contas.mapper";
import {
  executeFinancePlan,
  runContas,
  type FinanceExecDeps,
} from "../../app/usecases/import/executors/finance.executor";
import { detectFile } from "../../app/usecases/import/import-detector";
import { newReport } from "../../app/usecases/import/import.types";
import type { ImportContext } from "../../app/usecases/import/import.types";
import type { FinanceEntryCreate } from "../../app/interfaces/finance.interface";

const HEADER =
  "tipo,documento,cliente_cpf_cnpj,cliente_nome,valor,vencimento,status,pago_em,forma_pagamento,parcelas,observacao";

function contasCsv(lines: string[]) {
  return detectFile({
    fieldname: "file",
    filename: "contas.csv",
    buffer: Buffer.from([HEADER, ...lines].join("\n"), "utf8"),
  });
}

function makeDeps(
  customers: Array<{
    id: string;
    name?: string | null;
    cpf?: string | null;
    cnpj?: string | null;
  }> = [],
  existingMarkers: string[] = [],
) {
  const created: Array<{ kind: string; data: FinanceEntryCreate }> = [];
  const markPaid = vi.fn(); // NUNCA pode ser chamado pelo motor
  const createMock = vi.fn(
    async (kind: "receivable" | "payable", data: FinanceEntryCreate) => {
      created.push({ kind, data });
      return { id: `fin-${created.length}` } as never;
    },
  );
  const deps: FinanceExecDeps & {
    financeUseCase: { create: typeof createMock; markPaid: typeof markPaid };
  } = {
    financeUseCase: {
      create: createMock,
      markPaid,
    },
    loadCustomers: vi.fn(async () =>
      customers.map((c) => ({
        id: c.id,
        name: c.name ?? null,
        cpf: c.cpf ?? null,
        cnpj: c.cnpj ?? null,
      })),
    ),
    loadExistingMarkers: vi.fn(async () => existingMarkers),
  };
  return { deps, created, markPaid };
}

const ctx = (dryRun: boolean): ImportContext => ({
  targetUserId: "admin-1",
  files: [],
  dryRun,
});

describe("import/contas — mapper (validações do template)", () => {
  it("valida tipo/valor/vencimento/status/forma_pagamento por linha", () => {
    const r = mapContas(
      contasCsv([
        'receber,NF 12,52998224725,,"1.234,56",31/05/2024,paga,05/06/2024,PIX,2,venda balcão',
        "trocado,,,Maria,100,31/05/2024,pendente,,,,",
        "receber,,,Maria,0,31/05/2024,pendente,,,,",
        "receber,,,Maria,50,,pendente,,,,",
        "receber,,,Maria,50,31/05/2024,inexistente,,,,",
        "pagar,,,Fornecedor X,50,31/05/2024,pendente,,FIADO,,",
      ]),
    );
    expect(r.items).toHaveLength(1);
    const ok = r.items[0];
    expect(ok.kind).toBe("receivable");
    expect(ok.totalAmount).toBe(1234.56);
    expect(ok.status).toBe("PAGA");
    expect(ok.paidAt?.toISOString().slice(0, 10)).toBe("2024-06-05");
    expect(ok.paymentMethod).toBe("PIX");
    expect(ok.installments).toBe(2);
    expect(ok.reason).toContain("venda balcão");
    expect(ok.reason).toMatch(/\[import [0-9a-f]{8}\]/);

    const motivos = r.erros.map((e) => e.motivo).join(" | ");
    expect(motivos).toContain("tipo");
    expect(motivos).toContain("valor");
    expect(motivos).toContain("vencimento");
    expect(motivos).toContain("status");
    expect(motivos).toContain("FIADO");
  });

  it("conta sem cliente (nem doc nem nome) é bloqueada com mensagem clara", () => {
    const r = mapContas(contasCsv(["receber,,,,100,31/05/2024,pendente,,,,"]));
    expect(r.items).toHaveLength(0);
    expect(r.erros[0].motivo).toContain("cliente");
  });

  it("PAGA sem pago_em usa o vencimento com aviso", () => {
    const r = mapContas(contasCsv(["receber,,,Maria,100,31/05/2024,paga,,,,"]));
    expect(r.items[0].paidAt?.toISOString().slice(0, 10)).toBe("2024-05-31");
    expect(r.avisos.some((a) => a.motivo.includes("pago_em"))).toBe(true);
  });
});

describe("import/contas — executor", () => {
  it("casa cliente por CPF (prioridade) e por nome exato; PAGA vai pelo create e markPaid NUNCA roda", async () => {
    const { deps, created, markPaid } = makeDeps([
      { id: "c1", name: "Maria da Silva", cpf: "52998224725" },
      { id: "c2", name: "Fornecedor X" },
    ]);
    const mapped = mapContas(
      contasCsv([
        "receber,NF 1,52998224725,,100,31/05/2024,paga,05/06/2024,PIX,1,",
        "pagar,BOL 2,,Fornecedor X,200,30/06/2024,pendente,,BOLETO,1,",
      ]),
    );
    const report = newReport("DEXO", "CONTAS", "admin-1", false);
    await executeFinancePlan(ctx(false), report, mapped.items, deps);

    expect(created).toHaveLength(2);
    expect(created[0].kind).toBe("receivable");
    expect(created[0].data.customerId).toBe("c1");
    expect(created[0].data.status).toBe("PAGA");
    expect(created[0].data.paidAt).toBeInstanceOf(Date);
    expect(created[1].kind).toBe("payable");
    expect(created[1].data.customerId).toBe("c2");
    // GUARDRAIL: conta histórica paga NUNCA passa por markPaid.
    expect(markPaid).not.toHaveBeenCalled();
  });

  it("cliente não encontrado → erro de linha (nunca cria cliente); ambíguo idem", async () => {
    const { deps, created } = makeDeps([
      { id: "c1", name: "Maria" },
      { id: "c2", name: "Maria" },
    ]);
    const mapped = mapContas(
      contasCsv([
        "receber,,,Desconhecido,100,31/05/2024,pendente,,,,",
        "receber,,,Maria,100,31/05/2024,pendente,,,,",
      ]),
    );
    const report = newReport("DEXO", "CONTAS", "admin-1", false);
    await executeFinancePlan(ctx(false), report, mapped.items, deps);
    expect(created).toHaveLength(0);
    expect(report.contadores.cliente_nao_encontrado).toBe(1);
    expect(report.contadores.cliente_ambiguo).toBe(1);
    expect(report.erros.some((e) => e.motivo.includes("CPF/CNPJ"))).toBe(true);
  });

  it("idempotência: marker já gravado pula; 2ª rodada = 0 criações", async () => {
    const mapped = mapContas(
      contasCsv(["receber,NF 1,52998224725,,100,31/05/2024,pendente,,,,"]),
    );
    const hash = mapped.items[0].markerHash;
    const { deps, created } = makeDeps(
      [{ id: "c1", cpf: "52998224725", name: "Maria" }],
      [hash],
    );
    const report = newReport("DEXO", "CONTAS", "admin-1", false);
    await executeFinancePlan(ctx(false), report, mapped.items, deps);
    expect(created).toHaveLength(0);
    expect(report.contadores.ja_existiam_marker).toBe(1);
  });

  it("PRÉVIA não cria nada (runner integrado)", async () => {
    const { deps } = makeDeps([{ id: "c1", cpf: "52998224725", name: "Maria" }]);
    const file = contasCsv([
      "receber,NF 1,52998224725,,100,31/05/2024,pendente,,,,",
    ]);
    const report = await runContas(
      { targetUserId: "admin-1", files: [file], dryRun: true },
      deps,
    );
    expect(deps.financeUseCase.create).not.toHaveBeenCalled();
    expect(report.contadores.a_criar).toBe(1);
    expect(report.contadores.a_receber).toBe(1);
  });
});
