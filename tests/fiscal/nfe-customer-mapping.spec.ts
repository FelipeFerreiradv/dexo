import { describe, it, expect } from "vitest";
import {
  mapDestinatarioToCustomer,
  mapCustomerToDestinatario,
  mapMarketplaceBillingToDestinatario,
  resolveIndicadorIE,
} from "../../app/usecases/nfe-customer-mapping";

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

describe("resolveIndicadorIE", () => {
  it("prioriza o valor cadastrado quando válido", () => {
    expect(resolveIndicadorIE("1", false, null)).toBe("1");
    expect(resolveIndicadorIE("2", true, "12345")).toBe("2");
    expect(resolveIndicadorIE("9", true, "12345")).toBe("9");
  });
  it("ignora valor inválido e cai no fallback", () => {
    expect(resolveIndicadorIE("7", true, "12345")).toBe("1");
    expect(resolveIndicadorIE("", true, null)).toBe("9");
  });
  it("deriva: PJ com IE → 1, ISENTO → 2, PF/sem IE → 9", () => {
    expect(resolveIndicadorIE(null, true, "123456")).toBe("1");
    expect(resolveIndicadorIE(null, true, "isento")).toBe("2");
    expect(resolveIndicadorIE(null, false, "123456")).toBe("9"); // PF → não contribuinte
    expect(resolveIndicadorIE(null, false, null)).toBe("9");
    expect(resolveIndicadorIE(null, true, null)).toBe("9"); // PJ sem IE
  });
});

describe("mapCustomerToDestinatario", () => {
  it("mapeia PF completo com endereço e telefone (mobile fallback)", () => {
    const d = mapCustomerToDestinatario({
      personType: "PF",
      name: "Maria Souza",
      cpf: "52998224725",
      mobile: "11988887777",
      cep: "01001-000",
      street: "Praça da Sé",
      number: "10",
      neighborhood: "Sé",
      city: "São Paulo",
      state: "SP",
      ibge: "3550308",
    });
    expect(d.tipoPessoa).toBe("PF");
    expect(d.cpfCnpj).toBe("52998224725");
    expect(d.nome).toBe("Maria Souza");
    expect(d.indicadorIE).toBe("9");
    expect(d.telefone).toBe("11988887777");
    expect(d.municipio).toBe("São Paulo");
    expect(d.codMunicipio).toBe("3550308");
    expect(d.uf).toBe("SP");
    expect(d.codPais).toBe("1058");
  });

  it("mapeia PJ com IE → indicadorIE 1, usa razão social e CNPJ", () => {
    const d = mapCustomerToDestinatario({
      personType: "PJ",
      name: "Fantasia Peças",
      razaoSocial: "Peças Brasil LTDA",
      cnpj: "11444777000161",
      inscricaoEstadual: "123456789",
    });
    expect(d.tipoPessoa).toBe("PJ");
    expect(d.cpfCnpj).toBe("11444777000161");
    expect(d.nome).toBe("Peças Brasil LTDA");
    expect(d.inscricaoEstadual).toBe("123456789");
    expect(d.indicadorIE).toBe("1");
  });

  it("PJ isento → indicadorIE 2", () => {
    const d = mapCustomerToDestinatario({
      cnpj: "11444777000161",
      razaoSocial: "ACME",
      inscricaoEstadual: "ISENTO",
    });
    expect(d.tipoPessoa).toBe("PJ");
    expect(d.indicadorIE).toBe("2");
  });

  it("prefere o indicadorIE cadastrado no cliente", () => {
    const d = mapCustomerToDestinatario({
      personType: "PJ",
      cnpj: "11444777000161",
      razaoSocial: "ACME",
      inscricaoEstadual: "123",
      indicadorIE: "9",
    });
    expect(d.indicadorIE).toBe("9");
  });

  it("cliente sem documento não quebra (PF, campos vazios)", () => {
    const d = mapCustomerToDestinatario({ name: "Sem Doc" });
    expect(d.tipoPessoa).toBe("PF");
    expect(d.cpfCnpj).toBe("");
    expect(d.nome).toBe("Sem Doc");
    expect(d.indicadorIE).toBe("9");
  });

  it("infere PJ pelo CNPJ legado de entrega (deliveryCnpj)", () => {
    const d = mapCustomerToDestinatario({
      name: "Cliente",
      deliveryCnpj: "11444777000161",
      deliveryCorporateName: "Entrega LTDA",
    });
    expect(d.tipoPessoa).toBe("PJ");
    expect(d.cpfCnpj).toBe("11444777000161");
    expect(d.nome).toBe("Entrega LTDA");
  });

  it("auto-infere EXTERIOR quando codPais ≠ 1058", () => {
    const d = mapCustomerToDestinatario({
      name: "Foreign Buyer",
      codPais: "2496",
      pais: "URUGUAI",
    });
    expect(d.tipoPessoa).toBe("EXTERIOR");
    expect(d.codPais).toBe("2496");
    expect(d.pais).toBe("URUGUAI");
  });
});

describe("mapMarketplaceBillingToDestinatario", () => {
  it("PF (CPF) com endereço → destinatário completo", () => {
    const d = mapMarketplaceBillingToDestinatario(
      {
        name: "Andre",
        lastName: "Sousa",
        docType: "CPF",
        docNumber: "529.982.247-25",
        cep: "01001-000",
        street: "Praça da Sé",
        number: "100",
        neighborhood: "Sé",
        city: "São Paulo",
        uf: "BR-SP", // ML devolve ISO 3166-2
        countryId: "BR",
      },
      "ANDRESOUSA8025",
      null,
    );
    expect(d).not.toBeNull();
    expect(d!.tipoPessoa).toBe("PF");
    expect(d!.cpfCnpj).toBe("52998224725");
    expect(d!.nome).toBe("Andre Sousa");
    expect(d!.indicadorIE).toBe("9");
    expect(d!.cep).toBe("01001-000");
    expect(d!.municipio).toBe("São Paulo");
    expect(d!.uf).toBe("SP"); // normalizado de "BR-SP"
    expect(d!.codMunicipio).toBeNull(); // ML não fornece IBGE
    expect(d!.codPais).toBe("1058");
  });

  it("PJ (CNPJ 14 dígitos) → PJ", () => {
    const d = mapMarketplaceBillingToDestinatario({
      name: "Empresa X",
      docType: "CNPJ",
      docNumber: "11444777000161",
    });
    expect(d!.tipoPessoa).toBe("PJ");
    expect(d!.cpfCnpj).toBe("11444777000161");
  });

  it("sem documento → null (mantém o fallback nome do pedido)", () => {
    expect(
      mapMarketplaceBillingToDestinatario({ name: "Sem Doc" }, "Nick"),
    ).toBeNull();
  });

  it("usa o nome do pedido quando o billing não traz nome", () => {
    const d = mapMarketplaceBillingToDestinatario(
      { docType: "CPF", docNumber: "52998224725" },
      "ANDRESOUSA8025",
    );
    expect(d!.nome).toBe("ANDRESOUSA8025");
  });

  it("país estrangeiro → EXTERIOR", () => {
    const d = mapMarketplaceBillingToDestinatario({
      docType: "CPF",
      docNumber: "52998224725",
      countryId: "UY",
      countryName: "Uruguai",
    });
    expect(d!.tipoPessoa).toBe("EXTERIOR");
    expect(d!.pais).toBe("Uruguai");
  });
});
