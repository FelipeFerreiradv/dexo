import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseNfeXml } from "../app/fiscal/nfe-import/parse-nfe-xml";
import { lerXmlDeNfe } from "../app/ai/anexo/nfe-leitura";
import { parseChave } from "../app/fiscal/sefaz/chave-acesso";
import { isValidCnpj } from "../app/lib/masks";

// ===========================================================================
// O CABEÇALHO FISCAL DA NF-e — a correção de 13/08/2026.
//
// ⚠️ O DEFEITO QUE ISTO CONSERTA: `completar_fiscal_da_sucata` pedia ao modelo
// para "copiar os valores EXATAMENTE como aparecem na leitura do anexo" —
// valores que o parser NUNCA extraiu. A leitura tinha número da nota,
// fornecedor, contagem de itens e os valores das linhas, e mais nada. O lojista
// anexava o XML, pedia o preenchimento fiscal, e recebia um cartão com o número
// da nota; se o modelo tentasse a chave de acesso, ele a INVENTAVA — e só não
// virava lixo no banco porque o dígito verificador recusava do outro lado.
//
// ⭐⭐ A AFIRMAÇÃO CENTRAL DESTE SPEC: a corrente fecha. O que o parser extrai
// do XML atravessa a leitura e é ACEITO pelo `parseChave` da emissão de NF-e.
// Sem esse teste, "extraí a chave" e "a chave serve" seriam duas coisas
// diferentes, e a segunda é a que importa.
// ===========================================================================

const fx = (nome: string): string =>
  readFileSync(join(process.cwd(), "tests", "nfe-import", "fixtures", nome), "utf-8");

/** Monta um XML mínimo com o `ide`/`emit` que o teste quiser. */
function xmlCom(ide: string, emit = "<xNome>FORNECEDOR</xNome>"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00"><NFe><infNFe versao="4.00">
  <ide><mod>55</mod><nNF>9</nNF>${ide}</ide>
  <emit>${emit}</emit>
  <det nItem="1"><prod>
    <cProd>A</cProd><cEAN>SEM GTIN</cEAN><xProd>PECA</xProd>
    <uCom>UN</uCom><qCom>1</qCom><vUnCom>10</vUnCom><vProd>10</vProd>
  </prod></det>
</infNFe></NFe></nfeProc>`;
}

// ---------------------------------------------------------------------------

describe("⭐ o parser extrai o cabeçalho fiscal", () => {
  const r = parseNfeXml(fx("fiscal-completa.xml"));

  it("os seis campos saem do XML", () => {
    expect(r.meta.accessKey).toBe(
      "41260711222333000181550010000123451876543218",
    );
    expect(r.meta.emitCnpj).toBe("11222333000181");
    expect(r.meta.serie).toBe("1");
    expect(r.meta.issueDate).toBe("2026-07-15");
    expect(r.meta.operationNature).toBe(
      "COMPRA DE VEICULO SINISTRADO PARA DESMONTE",
    );
    expect(r.meta.icmsValue).toBe(1234.5);
  });

  it("a chave sai com 44 dígitos e SEM o prefixo `NFe`", () => {
    expect(r.meta.accessKey).toHaveLength(44);
    expect(r.meta.accessKey).toMatch(/^\d{44}$/);
  });

  it("⭐⭐ e a chave extraída é ACEITA pelo validador da emissão", () => {
    // É o encaixe que faz a correção valer alguma coisa: o que sai do parser
    // atravessa o `parseChave` que `completar_fiscal_da_sucata` usa. Sem isto,
    // "extraí a chave" não provaria que a chave serve.
    const partes = parseChave(r.meta.accessKey!);
    expect(partes.mod).toBe("55");
    expect(partes.CNPJ).toBe("11222333000181");
  });

  it("⭐ e o CNPJ extraído passa no dígito verificador que a tool exige", () => {
    expect(isValidCnpj(r.meta.emitCnpj!)).toBe(true);
  });

  it("⚠️ os itens continuam idênticos — a extração é ADITIVA", () => {
    expect(r.items).toHaveLength(1);
    expect(r.items[0].costPrice).toBe(8500);
    expect(r.items[0].quantity).toBe(1);
    expect(r.meta.numero).toBe("12345");
    expect(r.meta.emitName).toBe("SEGURADORA EXEMPLO S/A");
  });
});

describe("⚠️ o que falta na nota vira ausência, nunca um pedaço", () => {
  it("⭐ `Id` com menos de 44 dígitos NÃO devolve chave truncada", () => {
    // `single-item.xml` traz um Id sintético de 35 dígitos. Meia chave é pior
    // que chave nenhuma: ela seria transcrita, gravada e apontaria para nada.
    const r = parseNfeXml(fx("single-item.xml"));
    expect(r.meta.accessKey).toBeUndefined();
  });

  it("nota sem `Id` nenhum continua importando produto normalmente", () => {
    const r = parseNfeXml(fx("multi-item.xml"));
    expect(r.meta.accessKey).toBeUndefined();
    expect(r.items).toHaveLength(2);
  });

  it("nota sem total/ICMSTot não devolve ICMS zero — devolve nada", () => {
    // Zero seria uma AFIRMAÇÃO ("a nota não teve ICMS"); ausência é a verdade
    // ("a nota não declarou").
    const r = parseNfeXml(xmlCom(""));
    expect(r.meta.icmsValue).toBeUndefined();
  });

  it("⚠️ emitente pessoa física (CPF) não vira `emitCnpj`", () => {
    const r = parseNfeXml(
      xmlCom("", "<CPF>12345678909</CPF><xNome>JOAO DA SILVA</xNome>"),
    );
    expect(r.meta.emitCnpj).toBeUndefined();
    expect(r.meta.emitName).toBe("JOAO DA SILVA");
  });

  it("data em formato que o parser não reconhece vira ausência", () => {
    const r = parseNfeXml(xmlCom("<dhEmi>15/07/2026</dhEmi>"));
    expect(r.meta.issueDate).toBeUndefined();
  });

  it("⭐ leiaute 3.10 (`dEmi`, sem hora) também é lido", () => {
    const r = parseNfeXml(xmlCom("<dEmi>2026-07-15</dEmi>"));
    expect(r.meta.issueDate).toBe("2026-07-15");
  });

  it("⚠️ a chave NÃO é validada pelo parser — só extraída", () => {
    // Conferir o dígito verificador AQUI faria uma nota com chave torta parar
    // de importar produto, que é comportamento que já existia antes desta
    // mudança. Quem confere é quem vai GRAVAR a chave.
    const torta = "41260711222333000181550010000123451876543219"; // DV errado
    const r = parseNfeXml(
      fx("fiscal-completa.xml").replace(
        "41260711222333000181550010000123451876543218",
        torta,
      ),
    );
    expect(r.meta.accessKey).toBe(torta);
    expect(r.items).toHaveLength(1);
    expect(() => parseChave(torta)).toThrow();
  });
});

describe("⭐⭐ a leitura que chega ao modelo agora tem o que copiar", () => {
  const r = lerXmlDeNfe(fx("fiscal-completa.xml"));
  const leitura = r.ok ? r.leitura : "";

  it("a leitura foi produzida", () => {
    expect(r.ok).toBe(true);
  });

  it("cada campo aparece ROTULADO — é assim que o modelo sabe o que é o quê", () => {
    expect(leitura).toContain("Série: 1");
    expect(leitura).toContain("CNPJ do fornecedor: 11222333000181");
    expect(leitura).toContain(
      "Chave de acesso: 41260711222333000181550010000123451876543218",
    );
    expect(leitura).toContain(
      "Natureza da operação: COMPRA DE VEICULO SINISTRADO PARA DESMONTE",
    );
    expect(leitura).toContain("ICMS da nota: ");
  });

  it("⚠️ a chave sai LIMPA: sem pontuação, sem espaço, em uma linha só", () => {
    // São 44 dígitos que um LLM vai transcrever. Qualquer separador no meio é
    // um convite a copiar errado.
    const linha = leitura
      .split("\n")
      .find((l) => l.startsWith("Chave de acesso:"))!;
    expect(linha).toMatch(/^Chave de acesso: \d{44}$/);
  });

  it("⭐⭐ a data sai nos DOIS formatos, e esse é o ponto", () => {
    // O lojista confere `15/07/2026` contra a nota na mão; a ferramenta exige
    // `2026-07-15`. Publicar só um obrigaria alguém a converter — e converter
    // data é onde se troca mês por dia, num campo que ninguém reconfere depois.
    expect(leitura).toContain("Data de emissão: 15/07/2026");
    expect(leitura).toContain("(para a ferramenta: 2026-07-15)");
  });

  it("⚠️ a data NÃO passa por `new Date()` — fuso não pode comer um dia", () => {
    // `new Date("2026-07-15")` é meia-noite UTC; formatado em fuso negativo
    // vira 14/07. O corte é de string justamente por isso.
    expect(leitura).not.toContain("14/07/2026");
  });

  it("nota sem cabeçalho fiscal não ganha linha vazia nem `undefined`", () => {
    const s = lerXmlDeNfe(fx("multi-item.xml"));
    const texto = s.ok ? s.leitura : "";
    expect(texto).not.toContain("undefined");
    expect(texto).not.toContain("Chave de acesso:");
    expect(texto).not.toContain("CNPJ do fornecedor:");
    // E o que sempre existiu continua lá.
    expect(texto).toContain("Nota número 8");
    expect(texto).toContain("AMORTECEDOR DIANTEIRO");
  });

  it("⚠️ o resumo do cartão não muda — ele é o rótulo curto do anexo", () => {
    expect(r.ok && r.resumo).toContain("SEGURADORA EXEMPLO S/A");
    expect(r.ok && r.resumo).not.toContain("41260711222333");
  });
});
