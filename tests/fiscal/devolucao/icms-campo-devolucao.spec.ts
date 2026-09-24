/**
 * O campo de ICMS da devolução visto do lado da TELA: o que ele mostra, o que
 * recusa, e o que sai no corpo do PUT.
 *
 * O vizinho `devolucao-regime-icms.spec.ts` guarda o motor (o regime, a lista e
 * o veredito, em `app/fiscal/devolucao/tributacao.ts`). Aqui se guarda a outra
 * metade: que a tela usa esse motor em vez de adivinhar — e, sobretudo, que ela
 * NÃO escolhe imposto no lugar da dona do desmanche.
 *
 * Caso real (DLS AUTO PEÇAS, 24/09/2026): emitente do Simples Nacional
 * devolvendo uma COMPRA. O XML da fornecedora (regime normal) trouxe CST `00` e
 * CST `10` nos itens, então o campo NASCE carregando um código do regime
 * errado. Ela digitou `00` de novo, o campo decidiu pelo TAMANHO do texto
 * (`v.length === 3 ? csosn : cst`), salvou, e o bloqueio só apareceu depois como
 * "CST para emitente do Simples (Rejeição 591)". Seis rascunhos e um dia.
 */
import { describe, expect, it } from "vitest";

import {
  BLOQUEIO_CONFIRMAR,
  COMO_RESOLVER_ICMS,
  MOTIVO_SEM_CODIGO,
  ORIGEM_NOTA_ORIGINAL,
  PLACEHOLDER_ICMS,
  TITULO_CODIGO_NAO_SERVE,
  TITULO_SEM_CODIGO,
  campoIcms,
  codigoIcmsDoItem,
  overrideComIcms,
  paresDoCodigoIcms,
  regimeDoDetalhe,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-icms-campo";
import {
  regimeEmitenteDevolucao,
  tagIcmsParaDevolucao,
} from "../../../app/fiscal/devolucao/tributacao";

/** O bloco que o servidor manda no `DevolucaoDetalhe.emitente`, de verdade. */
const SIMPLES = regimeEmitenteDevolucao("SIMPLES");
const NORMAL = regimeEmitenteDevolucao("LUCRO_PRESUMIDO");
const SEM_REGIME = regimeEmitenteDevolucao(null);

const codigos = (v: { opcoes: { codigo: string }[] }) => v.opcoes.map((o) => o.codigo);

/** Os 12 da allowlist, na ordem em que o seletor os mostra. */
const CSOSN = ["102", "103", "300", "400", "500", "900"];
const CST = ["00", "40", "41", "50", "60", "90"];

describe("campoIcms — o caso da DLS: Simples Nacional com CST da fornecedora", () => {
  const campo = campoIcms({ emitente: SIMPLES, icmsDoItem: { cst: "00", csosn: null } });

  it("recusa o valor que veio da nota, dizendo o regime dela e o que o campo espera", () => {
    expect(campo.precisaEscolher).toBe(true);
    expect(campo.atualServe).toBe(false);
    expect(campo.causa).toBe("REGIME");
    expect(campo.titulo).toBe(TITULO_CODIGO_NAO_SERVE);
    // A frase nomeia o codigo, de quem ele e, o regime DELA e o que serve.
    expect(campo.motivo).toContain("00 é CST, de empresa do regime normal");
    expect(campo.motivo).toContain("A sua empresa é do Simples Nacional");
    expect(campo.motivo).toContain("CSOSN, de 3 dígitos");
    // A frase manda para a LISTA em vez de enumerar os seis códigos: eles estão
    // logo abaixo, cada um com o que significa. Enumerar aqui repetiria números
    // crus em CADA item recusado.
    expect(campo.motivo).toContain("escolha um na lista");
    expect(campo.motivo).not.toContain("102, 103, 300, 400, 500 ou 900");
    // Nada de "inválido" seco.
    expect(campo.motivo).not.toMatch(/^inv[áa]lido/i);
  });

  it("diz de onde veio o código errado — ela não o digitou", () => {
    expect(campo.origem).toBe(ORIGEM_NOTA_ORIGINAL);
    expect(campo.codigoAtual).toBe("00");
  });

  it("NÃO escolhe um código no lugar dela: o seletor nasce vazio", () => {
    expect(campo.valor).toBe("");
    expect(campo.tag).toBeNull();
    expect(campo.placeholder).toBe(PLACEHOLDER_ICMS);
    expect(campo.comoResolver).toBe(COMO_RESOLVER_ICMS);
  });

  it("só oferece os códigos do Simples — os SEIS dele, e `00` não está entre eles", () => {
    expect(codigos(campo)).toEqual(CSOSN);
    for (const c of CST) expect(codigos(campo)).not.toContain(c);
    expect(campo.opcoes.every((o) => o.tipo === "CSOSN")).toBe(true);
    expect(campo.rotulo).toContain("CSOSN");
    expect(campo.ajuda).toContain("Simples Nacional");
    // A ajuda (uma vez, no topo) continua enumerando: é a orientação do regime.
    expect(campo.ajuda).toContain("102, 103, 300, 400, 500 ou 900");
  });

  it("enquanto não há código que sirva, não há alíquota a pedir", () => {
    expect(campo.exigeAliquota).toBe(false);
  });

  it("o outro item real da DLS (CST 10) cai na mesma recusa", () => {
    const dez = campoIcms({ emitente: SIMPLES, icmsDoItem: { cst: "10", csosn: null } });
    expect(dez.precisaEscolher).toBe(true);
    // CST 10 não está nem na allowlist: a recusa é a de "o Dexo não emite".
    expect(dez.causa).toBe("NAO_SUPORTADO");
    expect(dez.motivo).toContain("CST 10");
    expect(dez.motivo).toContain("Escolha na lista");
    expect(codigos(dez)).toEqual(CSOSN);
  });
});

describe("campoIcms — quando o código serve", () => {
  it("Simples com CSOSN 102: aceita, mostra o grupo e não pede alíquota", () => {
    const c = campoIcms({ emitente: SIMPLES, icmsDoItem: { csosn: "102", cst: null } });
    expect(c.precisaEscolher).toBe(false);
    expect(c.atualServe).toBe(true);
    expect(c.valor).toBe("102");
    expect(c.tag).toBe("ICMSSN102");
    expect(c.exigeAliquota).toBe(false);
    expect(c.titulo).toBe("");
    expect(c.motivo).toBe("");
    expect(c.origem).toBe("");
  });

  it("CSOSN 900 leva alíquota — é o `exigeValores` do contrato, não um literal aqui", () => {
    const c = campoIcms({ emitente: SIMPLES, icmsDoItem: { csosn: "900", cst: null } });
    expect(c.exigeAliquota).toBe(true);
    expect(c.tag).toBe("ICMSSN900");
  });

  it("regime normal continua com CST — os SEIS dele, e o 00 serve", () => {
    const c = campoIcms({ emitente: NORMAL, icmsDoItem: { cst: "00", csosn: null } });
    expect(c.precisaEscolher).toBe(false);
    expect(c.valor).toBe("00");
    expect(c.tag).toBe("ICMS00");
    expect(c.exigeAliquota).toBe(true);
    expect(codigos(c)).toEqual(CST);
    expect(c.rotulo).toContain("CST");
    for (const x of CSOSN) expect(codigos(c)).not.toContain(x);
  });

  it("o espelho da DLS: regime normal com CSOSN é recusado citando o CST", () => {
    const c = campoIcms({ emitente: NORMAL, icmsDoItem: { csosn: "102", cst: null } });
    expect(c.precisaEscolher).toBe(true);
    expect(c.causa).toBe("REGIME");
    expect(c.motivo).toContain("102 é CSOSN, de empresa do Simples Nacional");
    expect(c.motivo).toContain("CST, de 2 dígitos");
    expect(c.motivo).toContain("escolha um na lista");
    expect(c.motivo).not.toContain("00, 40, 41, 50, 60 ou 90");
  });

  it("o CST 40 não leva alíquota (isenta) — o seletor sabe disso pelo contrato", () => {
    const c = campoIcms({ emitente: NORMAL, icmsDoItem: { cst: "40", csosn: null } });
    expect(c.exigeAliquota).toBe(false);
  });
});

describe("campoIcms — 103/300/400 e 41/50 são códigos de primeira classe", () => {
  // Eram tratados como "apelido" do 102 e do 40 e mostrados só quando o item já
  // os carregava. Era regressão: o construtor escreve o código LITERAL, então o
  // 400 (não tributada) é outra nota que o 102 (tributada sem crédito) — e a DLS
  // é do Simples devolvendo peça NÃO tributada. Agora estão na lista sempre.

  it("CSOSN 400 já está no seletor, com rótulo próprio, sem entrar duas vezes", () => {
    const c = campoIcms({ emitente: SIMPLES, icmsDoItem: { csosn: "400", cst: null } });
    expect(c.precisaEscolher).toBe(false);
    expect(c.valor).toBe("400");
    expect(c.tag).toBe("ICMSSN102");
    expect(codigos(c)).toEqual(CSOSN);
    // Sem duplicata: `comOCodigoAtual` não prepende o que já está lá.
    expect(codigos(c).filter((x) => x === "400")).toHaveLength(1);
    const quatrocentos = c.opcoes.find((o) => o.codigo === "400");
    expect(quatrocentos?.rotulo).toContain("Não tributada");
    // O rótulo é DELE, não emprestado do grupo — senão ela escolheria "400" e
    // leria "tributada pelo Simples" na mesma linha.
    expect(quatrocentos?.rotulo).not.toBe(c.opcoes.find((o) => o.codigo === "102")?.rotulo);
  });

  it("CST 50 idem, no regime normal", () => {
    const c = campoIcms({ emitente: NORMAL, icmsDoItem: { cst: "50", csosn: null } });
    expect(c.valor).toBe("50");
    expect(c.tag).toBe("ICMS40");
    expect(codigos(c)).toEqual(CST);
    expect(codigos(c).filter((x) => x === "50")).toHaveLength(1);
    expect(c.opcoes.find((o) => o.codigo === "50")?.rotulo).toContain("Suspensão");
  });
});

describe("campoIcms — o código que serve nunca fica sem opção no seletor", () => {
  /**
   * `comOCodigoAtual` parecia código morto depois dos 12 no seletor, mas NÃO é:
   * `regimeDoDetalhe` CONFIA na `icmsOpcoes` que veio no `DevolucaoDetalhe`, e ela
   * pode ser menor que a allowlist local — servidor ainda na versão de 7, resposta
   * truncada, ou entradas que `opcaoValida` descartou por virem quebradas.
   *
   * Sem ele o `<select>` ficaria com `value="400"` e nenhuma `<option>` "400": o
   * DOM renderiza em branco e a tela DIZ "nada escolhido" enquanto `campoIcms`
   * responde `valor: "400"`, `precisaEscolher: false`. Divergência silenciosa — e
   * ainda empurraria a operadora a trocar um código que o servidor aceita.
   */
  const servidorAntigo = (regime: typeof SIMPLES, mantidos: string[]) => ({
    regimeTributario: regime.regimeTributario,
    crt: regime.crt,
    tipoCodigoIcms: regime.tipoCodigoIcms,
    ajuda: regime.ajuda,
    icmsOpcoes: regime.icmsOpcoes.filter((o) => mantidos.includes(o.codigo)),
  });

  it("servidor ainda na lista de 7: o 400 do item entra como opção, dizendo de onde veio", () => {
    const c = campoIcms({
      emitente: servidorAntigo(SIMPLES, ["102", "500", "900"]),
      icmsDoItem: { csosn: "400", cst: null },
    });
    expect(c.precisaEscolher).toBe(false);
    expect(c.valor).toBe("400");
    expect(c.tag).toBe("ICMSSN102");
    expect(codigos(c)).toEqual(["400", "102", "500", "900"]);
    expect(c.opcoes[0].rotulo).toContain("veio da nota original");
    expect(c.opcoes[0].rotulo).toContain("102");
    expect(c.opcoes[0].exigeValores).toBe(false);
  });

  it("o mesmo no regime normal, com o 50", () => {
    const c = campoIcms({
      emitente: servidorAntigo(NORMAL, ["00", "40", "60", "90"]),
      icmsDoItem: { cst: "50", csosn: null },
    });
    expect(c.valor).toBe("50");
    expect(codigos(c)).toEqual(["50", "00", "40", "60", "90"]);
    expect(c.opcoes[0].rotulo).toContain("veio da nota original");
  });

  it("o invariante inteiro: sempre que há valor, existe opção com ele", () => {
    // É o que impede a tela de dizer "vazio" com `precisaEscolher: false`.
    const emitentes = [
      SIMPLES,
      NORMAL,
      SEM_REGIME,
      servidorAntigo(SIMPLES, ["102"]),
      servidorAntigo(NORMAL, ["00"]),
    ];
    const itens = [
      { csosn: "102", cst: null }, { csosn: "400", cst: null }, { csosn: "300", cst: null },
      { cst: "00", csosn: null }, { cst: "50", csosn: null }, { cst: "41", csosn: null },
      { cst: "10", csosn: null }, { cst: null, csosn: null },
    ];
    for (const emitente of emitentes) {
      for (const icmsDoItem of itens) {
        const c = campoIcms({ emitente, icmsDoItem });
        if (c.valor === "") continue;
        expect(codigos(c), `${c.crt}/${c.valor}`).toContain(c.valor);
        expect(c.precisaEscolher).toBe(false);
      }
    }
  });
});

describe("campoIcms — a escolha dela manda sobre o que veio do servidor", () => {
  it("escolheu 102 sobre o 00 da fornecedora: a recusa some", () => {
    const c = campoIcms({ emitente: SIMPLES, icmsDoItem: { cst: "00", csosn: null }, escolhido: "102" });
    expect(c.precisaEscolher).toBe(false);
    expect(c.valor).toBe("102");
    expect(c.titulo).toBe("");
    // O valor gravado continua sendo o que nao serve — a tela nao mente sobre isso.
    expect(c.atualServe).toBe(false);
    expect(c.codigoAtual).toBe("00");
  });

  it("voltou o seletor para o vazio: volta a faltar escolha, sem repetir a recusa antiga", () => {
    const c = campoIcms({ emitente: SIMPLES, icmsDoItem: { csosn: "102", cst: null }, escolhido: "" });
    expect(c.precisaEscolher).toBe(true);
    expect(c.valor).toBe("");
    expect(c.causa).toBe("VAZIO");
    expect(c.titulo).toBe("");
    expect(c.comoResolver).toBe(COMO_RESOLVER_ICMS);
  });

  it("se um `00` chegar ao campo pelas mãos dela, a recusa é a mesma — e sem culpar a nota", () => {
    const c = campoIcms({ emitente: SIMPLES, icmsDoItem: { csosn: "102", cst: null }, escolhido: "00" });
    expect(c.precisaEscolher).toBe(true);
    expect(c.causa).toBe("REGIME");
    expect(c.motivo).toContain("00 é CST, de empresa do regime normal");
    expect(c.origem).toBe("");
  });

  it("código fora da allowlist (CSOSN 201, que existe na lei): diz que o Dexo não emite", () => {
    const c = campoIcms({ emitente: SIMPLES, icmsDoItem: { csosn: "102", cst: null }, escolhido: "201" });
    expect(c.causa).toBe("NAO_SUPORTADO");
    expect(c.motivo).toContain("O Dexo não emite devolução com CSOSN 201");
    expect(c.motivo).toContain("Escolha na lista");
    // Os códigos que ele emite estão na lista, com rótulo — a frase não os repete.
    expect(c.motivo).not.toMatch(/\d, \d/);
    expect(codigos(c)).toEqual(CSOSN);
  });
});

describe("campoIcms — item sem ICMS nenhum", () => {
  it("não inventa código: diz que a original não trouxe e pede a escolha", () => {
    const c = campoIcms({ emitente: SIMPLES, icmsDoItem: { cst: null, csosn: null } });
    expect(c.precisaEscolher).toBe(true);
    expect(c.codigoAtual).toBeNull();
    expect(c.valor).toBe("");
    expect(c.titulo).toBe(TITULO_SEM_CODIGO);
    expect(c.motivo).toBe(MOTIVO_SEM_CODIGO);
    expect(c.origem).toBe("");
  });

  it("item ausente/indefinido não derruba a tela", () => {
    expect(campoIcms({ emitente: SIMPLES, icmsDoItem: null }).precisaEscolher).toBe(true);
    expect(campoIcms({ emitente: SIMPLES, icmsDoItem: undefined }).valor).toBe("");
  });
});

describe("regimeDoDetalhe — rede de segurança do contrato", () => {
  it("usa o bloco do servidor quando ele vem inteiro", () => {
    const r = regimeDoDetalhe(SIMPLES);
    expect(r.crt).toBe("1");
    expect(r.tipoCodigoIcms).toBe("CSOSN");
    expect(r.icmsOpcoes.map((o) => o.codigo)).toEqual(CSOSN);
  });

  it("servidor antigo (sem o campo): cai no regime desconhecido e aceita os DOIS", () => {
    const c = campoIcms({ emitente: undefined, icmsDoItem: { cst: "00", csosn: null } });
    // Sem regime o servidor tambem aceita os dois: a tela nao pode ser mais
    // rigida que ele, senao passa a bloquear nota que a SEFAZ autorizaria.
    expect(c.precisaEscolher).toBe(false);
    expect(c.valor).toBe("00");
    expect(codigos(c)).toEqual([...CSOSN, ...CST]);
    expect(c.ajuda).toBe(SEM_REGIME.ajuda);
    expect(c.ajuda).toContain("não está cadastrado");
  });

  it("bloco truncado (chegou `regimeTributario`, faltou a lista): reconstrói do regime", () => {
    const r = regimeDoDetalhe({ regimeTributario: "SIMPLES" });
    expect(r.crt).toBe("1");
    expect(r.icmsOpcoes.map((o) => o.codigo)).toEqual(CSOSN);
  });

  it("lista com lixo dentro não vira opção do seletor", () => {
    const r = regimeDoDetalhe({
      regimeTributario: "SIMPLES",
      crt: "1",
      tipoCodigoIcms: "CSOSN",
      ajuda: "…",
      icmsOpcoes: [{ codigo: "", tipo: "CSOSN" }, null, 7],
    });
    expect(r.icmsOpcoes.map((o) => o.codigo)).toEqual(CSOSN);
  });
});

describe("codigoIcmsDoItem", () => {
  it("CSOSN primeiro, igual à linha que a tela já mostrava", () => {
    expect(codigoIcmsDoItem({ csosn: "102", cst: "00" })).toBe("102");
    expect(codigoIcmsDoItem({ csosn: null, cst: "00" })).toBe("00");
    expect(codigoIcmsDoItem({ csosn: "  ", cst: " 40 " })).toBe("40");
    expect(codigoIcmsDoItem({ csosn: null, cst: null })).toBeNull();
    expect(codigoIcmsDoItem(undefined)).toBeNull();
  });
});

describe("paresDoCodigoIcms — o fim do `v.length === 3`", () => {
  it("o juiz é o do servidor: o par sai do regime, não do tamanho do texto", () => {
    expect(paresDoCodigoIcms("102", "1")).toEqual({ csosn: "102", cst: null });
    expect(paresDoCodigoIcms("00", "3")).toEqual({ cst: "00", csosn: null });
    // Zero a esquerda: o servidor normaliza, a tela manda o normalizado.
    expect(paresDoCodigoIcms("0", "3")).toEqual({ cst: "00", csosn: null });
    expect(paresDoCodigoIcms(" 40 ", "3")).toEqual({ cst: "40", csosn: null });
  });

  it("código do regime errado NÃO vira par — é o que a tela recusa", () => {
    expect(paresDoCodigoIcms("00", "1")).toBeNull();
    expect(paresDoCodigoIcms("102", "3")).toBeNull();
    expect(paresDoCodigoIcms("", "1")).toBeNull();
    expect(paresDoCodigoIcms(null, "1")).toBeNull();
    expect(paresDoCodigoIcms("abc", "1")).toBeNull();
  });

  it("todo código que o seletor oferece é aceito pelo montador do servidor", () => {
    for (const [crt, regime] of [
      ["1", SIMPLES],
      ["3", NORMAL],
      [null, SEM_REGIME],
    ] as const) {
      for (const opcao of regime.icmsOpcoes) {
        const par = paresDoCodigoIcms(opcao.codigo, crt);
        expect(par, `${crt}/${opcao.codigo}`).not.toBeNull();
        expect(tagIcmsParaDevolucao({ crt, ...(par as object) })).toBe(opcao.tag);
      }
    }
  });
});

describe("overrideComIcms — o corpo do PUT", () => {
  it("põe o par do código escolhido", () => {
    expect(overrideComIcms(undefined, { codigo: "102", crt: "1" })).toEqual({
      icms: { csosn: "102", cst: null },
    });
  });

  it("a alíquota viaja SEMPRE com o código — senão o servidor completa com o da fornecedora", () => {
    // `aplicarOverrideTributacao` faz `ov.icms.cst ?? t.icms.cst`: mandar so a
    // aliquota reenviaria o CST 00 gravado, e a 591 voltaria.
    expect(overrideComIcms(undefined, { codigo: "900", crt: "1", pICMS: 7 })).toEqual({
      icms: { csosn: "900", cst: null, pICMS: 7 },
    });
  });

  it("trocar de código mantém a alíquota já digitada", () => {
    const antes = overrideComIcms(undefined, { codigo: "900", crt: "1", pICMS: 12 });
    expect(overrideComIcms(antes, { codigo: "900", crt: "1" })).toEqual({
      icms: { csosn: "900", cst: null, pICMS: 12 },
    });
  });

  it("código que não serve não manda ICMS nenhum", () => {
    // Meio ajuste seria pior que nenhum: o servidor completaria com o gravado.
    expect(overrideComIcms(undefined, { codigo: "00", crt: "1" })).toBeUndefined();
    expect(overrideComIcms({ icms: { csosn: "102" } }, { codigo: "00", crt: "1" })).toBeUndefined();
  });

  it("limpar o seletor tira o ICMS mas não mexe em PIS/COFINS", () => {
    const antes = { icms: { csosn: "102", cst: null }, pis: { cst: "49" }, cofins: { cst: "49" } };
    expect(overrideComIcms(antes, { codigo: "", crt: "1" })).toEqual({
      pis: { cst: "49" },
      cofins: { cst: "49" },
    });
  });

  it("sem nada sobrando, o override some — `não mexi em imposto` continua sendo não mexer", () => {
    // Um override vazio ainda e um ajuste para o servidor (`temAjuste`), que
    // gravaria `ALTERADA_PELO_USUARIO` e requerRevisao em item que estava limpo.
    expect(overrideComIcms({ icms: { csosn: "102" } }, { codigo: "", crt: "1" })).toBeUndefined();
    expect(overrideComIcms(undefined, { codigo: "", crt: "1" })).toBeUndefined();
  });
});

describe("os textos falam com a dona do desmanche", () => {
  it("nenhuma mensagem do campo usa jargão seco de formulário", () => {
    for (const t of [
      COMO_RESOLVER_ICMS,
      ORIGEM_NOTA_ORIGINAL,
      BLOQUEIO_CONFIRMAR,
      MOTIVO_SEM_CODIGO,
      TITULO_CODIGO_NAO_SERVE,
      TITULO_SEM_CODIGO,
      PLACEHOLDER_ICMS,
    ]) {
      expect(t).not.toMatch(/inválido|invalido|erro de validação/i);
      expect(t.length).toBeGreaterThan(10);
    }
  });

  it("a lista mostra o número primeiro e explica o que o código significa", () => {
    for (const o of SIMPLES.icmsOpcoes) {
      expect(o.rotulo.startsWith(`${o.codigo} — `)).toBe(true);
      expect(o.rotulo.length).toBeGreaterThan(o.codigo.length + 20);
    }
  });
});
