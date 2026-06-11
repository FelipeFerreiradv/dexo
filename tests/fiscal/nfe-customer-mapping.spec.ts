import { describe, it, expect } from "vitest";
import { mapDestinatarioToCustomer } from "../../app/usecases/nfe-customer-mapping";

describe("mapDestinatarioToCustomer", () => {
  it("mapeia PF: CPF preenchido, sem campos PJ", () => {
    const c = mapDestinatarioToCustomer(
      {
        tipoPessoa: "PF",
        cpfCnpj: "529.982.247-25",
        nome: "João da Silva",
        email: "joao@x.com",
        telefone: "11999998888",
        cep: "01001-000",
        logradouro: "Praça da Sé",
        numero: "100",
        bairro: "Sé",
        municipio: "São Paulo",
        codMunicipio: "3550308",
        uf: "SP",
      },
      "user-1",
    );
    expect(c.userId).toBe("user-1");
    expect(c.personType).toBe("PF");
    expect(c.cpf).toBe("52998224725");
    expect(c.cnpj).toBeNull();
    expect(c.razaoSocial).toBeNull();
    expect(c.name).toBe("João da Silva");
    expect(c.email).toBe("joao@x.com");
    expect(c.phone).toBe("11999998888");
    expect(c.street).toBe("Praça da Sé");
    expect(c.ibge).toBe("3550308");
    expect(c.state).toBe("SP");
  });

  it("mapeia PJ (por tipoPessoa): CNPJ + razão social", () => {
    const c = mapDestinatarioToCustomer(
      {
        tipoPessoa: "PJ",
        cpfCnpj: "11.444.777/0001-61",
        nome: "Empresa Exemplo LTDA",
        inscricaoEstadual: "ISENTO",
      },
      "user-2",
    );
    expect(c.personType).toBe("PJ");
    expect(c.cnpj).toBe("11444777000161");
    expect(c.cpf).toBeNull();
    expect(c.razaoSocial).toBe("Empresa Exemplo LTDA");
    expect(c.name).toBe("Empresa Exemplo LTDA");
    expect(c.inscricaoEstadual).toBe("ISENTO");
  });

  it("infere PJ pelo comprimento do documento (14 dígitos) sem tipoPessoa", () => {
    const c = mapDestinatarioToCustomer(
      { cpfCnpj: "11444777000161", nome: "ACME" },
      "user-3",
    );
    expect(c.personType).toBe("PJ");
    expect(c.cnpj).toBe("11444777000161");
    expect(c.cpf).toBeNull();
  });

  it("documento e nome ausentes não quebram o mapeamento", () => {
    const c = mapDestinatarioToCustomer({ tipoPessoa: "PF" }, "user-4");
    expect(c.personType).toBe("PF");
    expect(c.cpf).toBeNull();
    expect(c.cnpj).toBeNull();
    expect(c.name).toBe("");
  });
});
