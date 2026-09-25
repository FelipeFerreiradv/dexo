/**
 * Devolução manual por CHAVE (sem XML): a chave diz quem emitiu a nota original
 * e de que estado — e isso tem de ser cruzado NA CRIAÇÃO (N-saldo-ledger-5).
 *
 * Antes: CNPJ e UF do fornecedor eram digitados à mão e só a emissão
 * reclamava (Rejeição 1194 para o CNPJ, 772/773 para o destino). UF em branco
 * travava a operação como INTERNA; como o destino fica preso no rascunho, a
 * saída era criar outro. Agora `parseManualBody` recusa no campo o que dá para
 * ver só com o corpo, e `conferirChaveDevolucaoManual` (para o caso de uso, que
 * conhece a empresa) confere a chave contra a empresa e deriva o destino.
 *
 * Mais o CFOP de combustível/lubrificante: o 5655 da DISAUTO passa a oferecer o
 * 5661 (devolução de compra de lubrificante para comercialização).
 */
import { describe, expect, it } from "vitest";

import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import { mapearCfopDevolucao } from "../../../app/fiscal/domain/devolucao-cfop";
import { conferirChaveDevolucaoManual, parseManualBody } from "../../../app/fiscal/devolucao/contrato";

const CNPJ_DLS = "57502966000144";
const CNPJ_DISAUTO = "80689839000975";

function chave(cnpj: string, cuf: string): string {
  const base = cuf + "2609" + cnpj + "55" + "001" + "000852899" + "1" + "75799182";
  return base + calcularDvChaveAcesso(base)!;
}
const DISAUTO_SC = chave(CNPJ_DISAUTO, "42");
const DISAUTO_PR = chave(CNPJ_DISAUTO, "41");
const DLS_SC = chave(CNPJ_DLS, "42");

const item = { nItem: 5, codigo: "33603-3", descricao: "PECA", ncm: "87089990", unidade: "UN", cfopOriginal: "5102", valorUnitario: 123.56, quantidade: 1 };

const manual = (tipo: "COMPRA_SAIDA" | "VENDA_ENTRADA", chaveAcesso: string, destinatario: Record<string, unknown> | null) =>
  parseManualBody({ tipo, chaveAcesso, confirmarSemXml: true, itens: [item], destinatario });

const campos = (r: ReturnType<typeof parseManualBody>) => (r.ok ? [] : r.erros.map((e) => e.campo));

describe("parseManualBody — chave × destinatário, recusado no campo", () => {
  it("devolução de compra com o CNPJ do fornecedor igual ao da chave: aceita", () => {
    expect(manual("COMPRA_SAIDA", DISAUTO_SC, { tipoPessoa: "PJ", cpfCnpj: "80.689.839/0009-75", nome: "DISAUTO", uf: "SC" }).ok).toBe(true);
  });

  it("CNPJ diferente do da chave: recusa em destinatario.cpfCnpj e diz qual é o certo (antes: Rejeição 1194 na emissão)", () => {
    const r = manual("COMPRA_SAIDA", DISAUTO_SC, { tipoPessoa: "PJ", cpfCnpj: "07504505000132", nome: "OUTRO", uf: "SC" });
    expect(campos(r)).toEqual(["destinatario.cpfCnpj"]);
    if (!r.ok) expect(r.erros[0].mensagem).toContain("80.689.839/0009-75");
  });

  it("UF diferente da UF da chave: recusa em destinatario.uf (antes: destino errado preso no rascunho)", () => {
    const r = manual("COMPRA_SAIDA", DISAUTO_PR, { tipoPessoa: "PJ", cpfCnpj: CNPJ_DISAUTO, nome: "DISAUTO", uf: "SC" });
    expect(campos(r)).toEqual(["destinatario.uf"]);
    if (!r.ok) expect(r.erros[0].mensagem).toContain("PR");
  });

  it("UF que não é sigla é recusada nos dois tipos; minúscula vira maiúscula", () => {
    expect(campos(manual("VENDA_ENTRADA", DLS_SC, { tipoPessoa: "PF", cpfCnpj: "12345678909", nome: "JOAO", uf: "XX" }))).toEqual(["destinatario.uf"]);
    const ok = manual("VENDA_ENTRADA", DLS_SC, { tipoPessoa: "PF", cpfCnpj: "12345678909", nome: "JOAO", uf: "sc" });
    expect(ok.ok && ok.value.modo === "CHAVE" && ok.value.destinatario?.uf).toBe("SC");
  });

  it("devolução de venda não compara o cliente com a chave (a chave é da própria empresa)", () => {
    expect(manual("VENDA_ENTRADA", DLS_SC, { tipoPessoa: "PJ", cpfCnpj: "07504505000132", nome: "CLIENTE", uf: "PR" }).ok).toBe(true);
  });

  it("sem destinatário, nada a cruzar (ela preenche no passo 2)", () => {
    expect(manual("COMPRA_SAIDA", DISAUTO_SC, null).ok).toBe(true);
  });
});

describe("conferirChaveDevolucaoManual — a chave contra a EMPRESA, e o destino que sai dela", () => {
  const DLS = { cnpj: "57.502.966/0001-44", uf: "SC" };

  it("compra: o destino sai da UF da chave, NUNCA da digitada (UF em branco não vira INTERNA à toa)", () => {
    expect(conferirChaveDevolucaoManual({ tipo: "COMPRA_SAIDA", chaveAcesso: DISAUTO_SC, destinatario: null, emitente: DLS }))
      .toEqual({ erros: [], idDest: 1, ufDestinatario: "SC" });
    expect(conferirChaveDevolucaoManual({ tipo: "COMPRA_SAIDA", chaveAcesso: DISAUTO_PR, destinatario: null, emitente: DLS }))
      .toEqual({ erros: [], idDest: 2, ufDestinatario: "PR" });
  });

  it("compra com a chave da PRÓPRIA empresa: recusa em chaveAcesso", () => {
    const r = conferirChaveDevolucaoManual({ tipo: "COMPRA_SAIDA", chaveAcesso: DLS_SC, destinatario: null, emitente: DLS });
    expect(r.erros.map((e) => e.campo)).toEqual(["chaveAcesso"]);
    expect(r.erros[0].mensagem).toContain("própria empresa");
  });

  it("venda com a chave de OUTRO CNPJ: recusa em chaveAcesso (antes o rascunho nascia morto para sempre)", () => {
    const r = conferirChaveDevolucaoManual({
      tipo: "VENDA_ENTRADA", chaveAcesso: DISAUTO_SC, emitente: DLS,
      destinatario: { tipoPessoa: "PF", cpfCnpj: "12345678909", uf: "SC" },
    });
    expect(r.erros.map((e) => e.campo)).toEqual(["chaveAcesso"]);
    expect(r.erros[0].mensagem).toContain("80.689.839/0009-75");
  });

  it("venda: destino pela UF do cliente; sem UF, pelo CFOP da venda; os dois juntos têm de concordar", () => {
    const venda = (uf: string | null, cfop: string | null) =>
      conferirChaveDevolucaoManual({
        tipo: "VENDA_ENTRADA", chaveAcesso: DLS_SC, emitente: DLS,
        destinatario: { tipoPessoa: "PF", cpfCnpj: "12345678909", uf },
        itens: [{ cfopOriginal: cfop }],
      });
    expect(venda("PR", null)).toMatchObject({ erros: [], idDest: 2, ufDestinatario: "PR" });
    expect(venda(null, "5102")).toMatchObject({ erros: [], idDest: 1 });
    expect(venda(null, "6102")).toMatchObject({ erros: [], idDest: 2 });
    const briga = venda("SC", "6102");
    expect(briga.erros.map((e) => e.campo)).toEqual(["destinatario.uf"]);
    expect(briga.erros[0].mensagem).toContain("fora do estado");
    const nada = venda(null, null);
    expect(nada.idDest).toBeNull();
    expect(nada.erros[0].mensagem).toContain("Informe a UF do cliente");
  });

  it("cliente do exterior ⇒ destino 3; chave inválida ⇒ erro de chave", () => {
    expect(conferirChaveDevolucaoManual({
      tipo: "VENDA_ENTRADA", chaveAcesso: DLS_SC, emitente: DLS,
      destinatario: { tipoPessoa: "EXTERIOR", cpfCnpj: "", uf: "EX" },
    }).idDest).toBe(3);
    expect(conferirChaveDevolucaoManual({ tipo: "COMPRA_SAIDA", chaveAcesso: "123", destinatario: null, emitente: DLS }).erros[0].campo).toBe("chaveAcesso");
  });
});

describe("CFOP de combustível/lubrificante: o 5655 da DISAUTO oferece o 5661", () => {
  it("venda do fornecedor para comercialização (5655/5652) → sugere 5661 primeiro", () => {
    for (const cfop of ["5655", "5652"]) {
      const m = mapearCfopDevolucao({ cfopOriginal: cfop, tipo: "COMPRA_SAIDA", idDestOriginal: 1, crt: "1" });
      expect(m.status).toBe("ESCOLHA");
      expect(m.opcoes[0]).toBe("5661");
      // As opções de antes continuam lá.
      expect(m.opcoes).toEqual(expect.arrayContaining(["5202", "5201", "5411", "5410", "5553", "5556"]));
    }
  });

  it("industrialização → 5660; consumo → 5662; interestadual → 66xx", () => {
    expect(mapearCfopDevolucao({ cfopOriginal: "5654", tipo: "COMPRA_SAIDA", idDestOriginal: 1 }).opcoes[0]).toBe("5660");
    expect(mapearCfopDevolucao({ cfopOriginal: "5656", tipo: "COMPRA_SAIDA", idDestOriginal: 1 }).opcoes[0]).toBe("5662");
    expect(mapearCfopDevolucao({ cfopOriginal: "6655", tipo: "COMPRA_SAIDA", idDestOriginal: 2 }).opcoes[0]).toBe("6661");
  });

  it("MEI continua na lista restrita (5202)", () => {
    expect(mapearCfopDevolucao({ cfopOriginal: "5655", tipo: "COMPRA_SAIDA", idDestOriginal: 1, crt: "4" })).toMatchObject({ status: "MAPEADO", cfop: "5202" });
  });
});
