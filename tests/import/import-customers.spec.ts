import { describe, it, expect, vi, beforeEach } from "vitest";
import XLSX from "xlsx";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    customer: { findMany: vi.fn(async () => []) },
  },
}));

import {
  executeCustomersPlan,
  runVaaptCustomers,
  runWdCustomers,
  type CustomersExecDeps,
} from "../../app/usecases/import/executors/customers.executor";
import { mapVaaptCustomers } from "../../app/usecases/import/mappers/vaapt-clientes.mapper";
import { detectFile } from "../../app/usecases/import/import-detector";
import { newReport } from "../../app/usecases/import/import.types";
import type { ImportContext } from "../../app/usecases/import/import.types";
import type { CustomerCreate } from "../../app/interfaces/customer.interface";

const HEADER = [
  "# Cod Cliente",
  "Nome Cliente",
  "CPF",
  "CNPJ",
  "Endereco",
  "Numero",
  "Complemento",
  "Bairro",
  "Cidade",
  "UF",
  "CEP",
  "Telefone",
  "Email",
  "RG",
  "IE",
  "TipoPessoa",
];

function clientesFile(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([HEADER, ...rows]),
    "Planilha1",
  );
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return detectFile({ fieldname: "file", filename: "clientes.xlsx", buffer });
}

function customersCsv(lines: string[]) {
  const header =
    "Id,CompanyId,CreatedAt,UpdatedAt,Name,FantasyName,Type,Document,RgIe,Phone,CellPhone,Email";
  return detectFile({
    fieldname: "file",
    filename: "customers.csv",
    buffer: Buffer.from([header, ...lines].join("\n"), "utf8"),
  });
}

function makeDeps(
  existing: Array<{
    cpf?: string | null;
    cnpj?: string | null;
    name?: string | null;
    phone?: string | null;
    notes?: string | null;
  }> = [],
) {
  const created: CustomerCreate[] = [];
  const deps: CustomersExecDeps = {
    customerUseCase: {
      create: vi.fn(async (data: CustomerCreate) => {
        created.push(data);
        return { id: `cust-${created.length}` } as never;
      }),
    },
    loadExistingCustomers: vi.fn(async () =>
      existing.map((e) => ({
        cpf: e.cpf ?? null,
        cnpj: e.cnpj ?? null,
        name: e.name ?? null,
        phone: e.phone ?? null,
        mobile: null,
        notes: e.notes ?? null,
      })),
    ),
  };
  return { deps, created };
}

const ctx = (dryRun: boolean): ImportContext => ({
  targetUserId: "admin-1",
  files: [],
  dryRun,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("import/clientes — mapper Vaapt", () => {
  it("mapeia docs com padDoc, endereço e markers; descarta placeholders", () => {
    const file = clientesFile([
      // CPF veio como número do Excel (perdeu o zero à esquerda).
      ["1", "Maria da Silva", 1234567890, null, "Rua A", "10", "undefined", "Centro", "Itajaí", "sc", "8830100", "(47) 9999-0000", "maria@x.com", null, null, "PF"],
      ["2", "NÃO IDENTIFICADO", null, null, null, null, null, null, null, null, null, null, null, null, null, "PF"],
      ["3", "Auto Peças LTDA", null, "1234567000195", null, null, null, null, null, "XX", null, null, null, null, "123", "PJ"],
    ]);
    const r = mapVaaptCustomers(file);
    expect(r.items).toHaveLength(2);
    expect(r.skippedPlaceholder).toBe(1);

    const maria = r.items[0];
    expect(maria.cpf).toBe("01234567890"); // zero recuperado
    expect(maria.state).toBe("SC");
    expect(maria.cep).toBe("08830100");
    expect(maria.phone).toBe("4799990000");
    expect(maria.complement).toBeNull(); // literal "undefined" limpo
    expect(maria.notes).toContain("cliente #1");

    const pj = r.items[1];
    expect(pj.personType).toBe("PJ");
    expect(pj.cnpj).toBe("01234567000195");
    expect(pj.indicadorIE).toBe("1"); // PJ com IE
    expect(pj.state).toBeNull(); // UF inválida descartada
    expect(r.avisos.some((a) => a.motivo.includes("UF inválida"))).toBe(true);
  });

  it("dedup intra-planilha por cod/cpf/cnpj", () => {
    const file = clientesFile([
      ["1", "Maria", "52998224725", null, null, null, null, null, null, null, null, null, null, null, null, "PF"],
      ["1", "Maria de novo", null, null, null, null, null, null, null, null, null, null, null, null, null, "PF"],
      ["2", "Outra Maria", "52998224725", null, null, null, null, null, null, null, null, null, null, null, null, "PF"],
    ]);
    const r = mapVaaptCustomers(file);
    expect(r.items).toHaveLength(1);
    expect(r.skippedDuplicateInSheet).toBe(2);
  });
});

describe("import/clientes — mapper WebDesmonte (customers.csv)", () => {
  it("decide PF/PJ pelo documento e mapeia RgIe conforme o tipo", async () => {
    const file = customersCsv([
      "g1,260,,,MARIA,,F,52998224725,12345,4799990000,4788880000,maria@x.com",
      "g2,260,,,SUCATA LTDA,Sucatao,J,01234567000195,ISENTO,,,",
    ]);
    const { deps, created } = makeDeps([]);
    const report = await runWdCustomers(
      { targetUserId: "admin-1", files: [file], dryRun: false },
      deps,
    );
    expect(report.contadores.criados).toBe(2);
    const pf = created[0];
    expect(pf.personType).toBe("PF");
    expect(pf.cpf).toBe("52998224725");
    expect(pf.rg).toBe("12345");
    expect(pf.mobile).toBe("4788880000");
    const pj = created[1];
    expect(pj.personType).toBe("PJ");
    expect(pj.cnpj).toBe("01234567000195");
    expect(pj.inscricaoEstadual).toBe("ISENTO");
    expect(pj.nomeFantasia).toBe("Sucatao");
    expect(String(pj.notes)).toContain("cliente #g2");
  });
});

describe("import/clientes — executor (dedup em camadas + idempotência)", () => {
  const items = () =>
    mapVaaptCustomers(
      clientesFile([
        ["1", "Maria", "52998224725", null, null, null, null, null, null, null, null, "47999990000", null, null, null, "PF"],
        ["2", "José sem doc", null, null, null, null, null, null, null, null, null, "47888880000", null, null, null, "PF"],
      ]),
    ).items;

  it("marker legado ('Legado 704 · cliente #1') deduplica sem doc", async () => {
    const { deps, created } = makeDeps([
      { notes: "Legado 704 · cliente #1" },
    ]);
    const report = newReport("VAAPT", "CLIENTES", "admin-1", false);
    await executeCustomersPlan(ctx(false), report, items(), deps);
    expect(report.contadores.ja_existiam_marker).toBe(1);
    expect(created).toHaveLength(1); // só o José
  });

  it("CPF existente deduplica; nome+telefone deduplica quem não tem doc", async () => {
    const { deps, created } = makeDeps([
      { cpf: "52998224725" },
      { name: "José sem doc", phone: "47888880000" },
    ]);
    const report = newReport("VAAPT", "CLIENTES", "admin-1", false);
    await executeCustomersPlan(ctx(false), report, items(), deps);
    expect(report.contadores.ja_existiam_cpf).toBe(1);
    expect(report.contadores.ja_existiam_nome_telefone).toBe(1);
    expect(created).toHaveLength(0);
  });

  it("2ª rodada = 0 criações (idempotência ponta a ponta)", async () => {
    const { deps, created } = makeDeps([]);
    const report1 = newReport("VAAPT", "CLIENTES", "admin-1", false);
    await executeCustomersPlan(ctx(false), report1, items(), deps);
    expect(created).toHaveLength(2);

    // Simula o estado pós-1ª rodada: os criados agora existem no banco.
    const { deps: deps2, created: created2 } = makeDeps(
      created.map((c) => ({
        cpf: c.cpf ?? null,
        cnpj: c.cnpj ?? null,
        name: c.name,
        phone: c.phone ?? null,
        notes: c.notes ?? null,
      })),
    );
    const report2 = newReport("VAAPT", "CLIENTES", "admin-1", false);
    await executeCustomersPlan(ctx(false), report2, items(), deps2);
    expect(created2).toHaveLength(0);
    expect(
      (report2.contadores.ja_existiam_marker ?? 0) +
        (report2.contadores.ja_existiam_cpf ?? 0) +
        (report2.contadores.ja_existiam_nome_telefone ?? 0),
    ).toBe(2);
  });

  it("PRÉVIA não chama create", async () => {
    const { deps } = makeDeps([]);
    const report = newReport("VAAPT", "CLIENTES", "admin-1", true);
    await executeCustomersPlan(ctx(true), report, items(), deps);
    expect(deps.customerUseCase.create).not.toHaveBeenCalled();
    expect(report.contadores.a_criar).toBe(2);
  });

  it("cliente SEM cod/doc/telefone ganha pseudo-cod determinístico e não duplica na 2ª rodada", async () => {
    const file = clientesFile([
      [null, "Cliente Sem Nada", null, null, null, null, null, null, null, null, null, null, null, null, null, "PF"],
    ]);
    const mapped = mapVaaptCustomers(file);
    expect(mapped.items[0].cod).toMatch(/^nd-[0-9a-f]{8}$/);
    expect(mapped.items[0].notes).toContain(`cliente #${mapped.items[0].cod}`);

    // 1ª rodada cria; 2ª rodada (marker no banco) deduplica.
    const { deps, created } = makeDeps([]);
    const r1 = newReport("VAAPT", "CLIENTES", "admin-1", false);
    await executeCustomersPlan(ctx(false), r1, mapped.items, deps);
    expect(created).toHaveLength(1);

    const { deps: deps2, created: created2 } = makeDeps([
      { name: "Cliente Sem Nada", notes: String(created[0].notes) },
    ]);
    const r2 = newReport("VAAPT", "CLIENTES", "admin-1", false);
    await executeCustomersPlan(ctx(false), r2, mapped.items, deps2);
    expect(created2).toHaveLength(0);
    expect(r2.contadores.ja_existiam_marker).toBe(1);
  });

  it("'Já existe um cliente com esse CPF' do usecase vira skip, não erro", async () => {
    const deps: CustomersExecDeps = {
      customerUseCase: {
        create: vi.fn(async () => {
          throw new Error("Já existe um cliente com esse CPF");
        }),
      },
      loadExistingCustomers: vi.fn(async () => []),
    };
    const report = newReport("VAAPT", "CLIENTES", "admin-1", false);
    await executeCustomersPlan(ctx(false), report, items().slice(0, 1), deps);
    expect(report.contadores.ja_existiam_corrida).toBe(1);
    expect(report.contadores.erros ?? 0).toBe(0);
  });

  it("runner Vaapt integra mapper+executor com contadores de mapeamento", async () => {
    const { deps } = makeDeps([]);
    const file = clientesFile([
      ["1", "Maria", "52998224725", null, null, null, null, null, null, null, null, null, null, null, null, "PF"],
      ["2", "NÃO IDENTIFICADO", null, null, null, null, null, null, null, null, null, null, null, null, null, "PF"],
    ]);
    const report = await runVaaptCustomers(
      { targetUserId: "admin-1", files: [file], dryRun: true },
      deps,
    );
    expect(report.contadores.linhas_no_arquivo).toBe(2);
    expect(report.contadores.clientes_validos).toBe(1);
    expect(report.contadores.placeholders_descartados).toBe(1);
    expect(report.contadores.a_criar).toBe(1);
  });
});
