import { describe, it, expect } from "vitest";
import { customerSchema } from "../app/clientes/lib/customer-schema";

// CNPJ válido de teste (dígitos verificadores corretos) e variações inválidas.
const VALID_CNPJ = "11.444.777/0001-61";
const INVALID_CNPJ = "11.444.777/0001-99";

function parse(input: Record<string, unknown>) {
  return customerSchema.safeParse(input);
}

function messages(result: ReturnType<typeof parse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.message);
}

describe("customerSchema — Pessoa Física", () => {
  it("aceita PF com nome", () => {
    const r = parse({ personType: "PF", name: "João da Silva" });
    expect(r.success).toBe(true);
  });

  it("PF sem nome é rejeitada", () => {
    const r = parse({ personType: "PF", name: "" });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain("Nome é obrigatório");
  });

  it("default é PF quando personType é omitido (exige nome)", () => {
    const r = parse({ name: "" });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain("Nome é obrigatório");
  });

  it("PF aceita CPF vazio (opcional)", () => {
    const r = parse({ personType: "PF", name: "Maria", cpf: "" });
    expect(r.success).toBe(true);
  });

  it("PF com CPF inválido é rejeitada", () => {
    const r = parse({ personType: "PF", name: "Maria", cpf: "123.456.789-00" });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain("CPF inválido");
  });
});

describe("customerSchema — Pessoa Jurídica", () => {
  it("aceita PJ com razão social e CNPJ válido", () => {
    const r = parse({
      personType: "PJ",
      razaoSocial: "Empresa Exemplo LTDA",
      cnpj: VALID_CNPJ,
    });
    expect(r.success).toBe(true);
  });

  it("PJ sem razão social é rejeitada", () => {
    const r = parse({ personType: "PJ", razaoSocial: "", cnpj: VALID_CNPJ });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain("Razão social é obrigatória");
  });

  it("PJ sem CNPJ é rejeitada", () => {
    const r = parse({ personType: "PJ", razaoSocial: "Empresa X", cnpj: "" });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain("CNPJ é obrigatório");
  });

  it("PJ com CNPJ inválido mostra erro de formato", () => {
    const r = parse({
      personType: "PJ",
      razaoSocial: "Empresa X",
      cnpj: INVALID_CNPJ,
    });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain("CNPJ informado é inválido");
  });

  it("PJ não exige nome (a obrigatoriedade recai sobre razão social)", () => {
    const r = parse({
      personType: "PJ",
      name: "",
      razaoSocial: "Empresa Exemplo LTDA",
      cnpj: VALID_CNPJ,
    });
    expect(r.success).toBe(true);
  });
});
