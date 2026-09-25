/**
 * Os campos de PIS e de COFINS da devolução vistos do lado da TELA
 * (`app/notas-fiscais/lib/nfe-devolucao-pis-cofins-campo.ts`): o que mostram, o
 * que recusam e o que sai no corpo do PUT.
 *
 * Caso real (DLS AUTO PEÇAS, Simples Nacional, 24/09/2026): PIS e COFINS eram
 * caixas de texto livre com o exemplo "CST". Ela ficou 70 minutos chutando 01,
 * 49, 01, 49; digitar o CST depois da alíquota APAGAVA a alíquota (`{cst: v}`); e
 * a caixa de alíquota era `defaultValue` — mostrava 1,65% com 0% gravado (K1,
 * K3, N-pis-cofins-ipi-4/8, N-fluxo-6).
 *
 * O motor (lista, rótulos e veredito) é o do servidor e é guardado em
 * `devolucao-regime-pis-cofins.spec.ts`; aqui se guarda que a tela o usa, que
 * não escolhe código por ela e que código e alíquota viajam juntos.
 */
import { describe, expect, it } from "vitest";

import {
  BLOQUEIO_CONFIRMAR_PIS_COFINS,
  aliquotaPisCofins,
  campoPisCofins,
  gruposPisCofins,
  lerAliquota,
  opcoesPisCofinsDoDetalhe,
  overrideComPisCofins,
  recusasPisCofins,
  rotuloCampoPisCofins,
  semAliquotaPisCofins,
  textoDaAliquota,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-pis-cofins-campo";
import { ORIGEM_NOTA_ORIGINAL } from "../../../app/notas-fiscais/lib/nfe-devolucao-icms-campo";
import {
  checarCstPisCofinsDevolucao,
  opcoesPisCofinsDevolucao,
  regimeEmitenteDevolucao,
} from "../../../app/fiscal/devolucao/tributacao";

const SIMPLES_COMPRA = regimeEmitenteDevolucao("SIMPLES", "COMPRA_SAIDA");
const NORMAL_COMPRA = regimeEmitenteDevolucao("LUCRO_REAL", "COMPRA_SAIDA");
const SIMPLES_VENDA = regimeEmitenteDevolucao("SIMPLES", "VENDA_ENTRADA");

const codigos = (v: { opcoes: { codigo: string }[] }) => v.opcoes.map((o) => o.codigo);

describe("campoPisCofins — DLS: Simples Nacional com o 01 da DISAUTO gravado", () => {
  const pis = campoPisCofins({
    emitente: SIMPLES_COMPRA,
    tipo: "COMPRA_SAIDA",
    tributo: "pis",
    gravado: { cst: "01" },
  });

  it("recusa o 01 na hora, dizendo o regime dela, e o seletor nasce VAZIO", () => {
    expect(pis.precisaEscolher).toBe(true);
    expect(pis.causa).toBe("REGIME");
    expect(pis.valor).toBe("");
    expect(pis.codigoAtual).toBe("01");
    expect(pis.titulo).toBe("O código do PIS deste item não serve para a sua empresa");
    expect(pis.motivo).toContain("Simples Nacional");
    expect(pis.origem).toBe(ORIGEM_NOTA_ORIGINAL);
    expect(pis.exigeAliquota).toBe(false);
  });

  it("não oferece 01 nem 02 a uma empresa do Simples; o 49 e o 04 estão no topo", () => {
    expect(codigos(pis)).not.toContain("01");
    expect(codigos(pis)).not.toContain("02");
    expect(codigos(pis).slice(0, 2)).toEqual(["49", "04"]);
    // Cada opção leva o que o código quer dizer, não só o número.
    expect(pis.opcoes.find((o) => o.codigo === "04")?.rotulo).toContain("Monofásica");
  });

  it("o rótulo diz de qual tributo é o campo", () => {
    expect(pis.rotulo).toBe("Código do PIS (CST)");
    expect(rotuloCampoPisCofins("cofins")).toBe("Código da COFINS (CST)");
  });

  it("escolhido o 49, a recusa some e o campo pede a alíquota", () => {
    const c = campoPisCofins({ emitente: SIMPLES_COMPRA, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "01" }, escolhido: "49" });
    expect(c.precisaEscolher).toBe(false);
    expect(c.valor).toBe("49");
    expect(c.exigeAliquota).toBe(true);
    expect(c.titulo).toBe("");
  });

  it("o 04 (monofásico) não leva alíquota — a caixa some", () => {
    const c = campoPisCofins({ emitente: SIMPLES_COMPRA, tipo: "COMPRA_SAIDA", tributo: "cofins", gravado: { cst: "04" } });
    expect(c.precisaEscolher).toBe(false);
    expect(c.valor).toBe("04");
    expect(c.exigeAliquota).toBe(false);
    expect(semAliquotaPisCofins("cofins")).toContain("a COFINS sai sem valor");
  });
});

describe("campoPisCofins — o resto do juiz", () => {
  it("regime normal: o 01 serve e mostra o código gravado no seletor", () => {
    const c = campoPisCofins({ emitente: NORMAL_COMPRA, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "01" } });
    expect(c.precisaEscolher).toBe(false);
    expect(c.valor).toBe("01");
    expect(codigos(c)).toContain("01");
  });

  // ATUALIZADO (onda 5, decisão 3 do dono): era "AVISO junto do campo, não
  // recusa". CST de entrada numa devolução de compra (nota de saída) passou a ser
  // RECUSADO pelo juiz do servidor (causa SENTIDO) — nenhuma nota de fornecedor
  // traz CST de entrada, não há herança a proteger. O campo usa o mesmo juiz:
  // agora recusa na hora, com o motivo, e o seletor nasce vazio.
  it("CST de entrada numa devolução de compra (saída) é RECUSADO junto do campo, com o motivo", () => {
    const c = campoPisCofins({ emitente: NORMAL_COMPRA, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "50" } });
    expect(c.precisaEscolher).toBe(true);
    expect(c.causa).toBe("SENTIDO");
    expect(c.valor).toBe("");
    expect(c.motivo).toContain("é de entrada");
    expect(c.titulo).toBe("O código do PIS deste item não serve na devolução");
    expect(codigos(c)).not.toContain("50");
  });

  it("devolução de VENDA do Simples: o 49 herdado das próprias vendas continua servindo (só avisa)", () => {
    const c = campoPisCofins({ emitente: SIMPLES_VENDA, tipo: "VENDA_ENTRADA", tributo: "pis", gravado: { cst: "49" } });
    expect(c.precisaEscolher).toBe(false);
    expect(c.avisoTexto).toContain("é de saída");
  });

  it("sem código gravado (nota original com CST 03): diz qual veio e por que não serve", () => {
    const c = campoPisCofins({
      emitente: SIMPLES_COMPRA,
      tipo: "COMPRA_SAIDA",
      tributo: "pis",
      gravado: { cst: null },
      codigoDaNota: "03",
    });
    expect(c.precisaEscolher).toBe(true);
    expect(c.causa).toBe("VAZIO");
    expect(c.titulo).toBe("Este item veio sem código do PIS");
    expect(c.motivo).toContain("CST 03");
    expect(c.motivo).toContain("por quantidade");
    expect(c.valor).toBe("");
  });

  it("voltou o seletor para o vazio: volta a faltar escolha, sem repetir a recusa antiga", () => {
    const c = campoPisCofins({ emitente: NORMAL_COMPRA, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "01" }, escolhido: "" });
    expect(c.precisaEscolher).toBe(true);
    expect(c.titulo).toBe("");
    expect(c.origem).toBe("");
  });

  it("servidor antigo (sem `pisCofinsOpcoes`): a lista sai da MESMA função do servidor", () => {
    const antigo = { regimeTributario: "SIMPLES" };
    expect(opcoesPisCofinsDoDetalhe(antigo, "COMPRA_SAIDA").map((o) => o.codigo)).toEqual(
      opcoesPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA" }).map((o) => o.codigo),
    );
  });

  it("lista com lixo dentro não vira opção", () => {
    const lixo = { ...SIMPLES_COMPRA, pisCofinsOpcoes: [null, 7, { codigo: "1" }] };
    expect(opcoesPisCofinsDoDetalhe(lixo, "COMPRA_SAIDA").map((o) => o.codigo)).toEqual(
      opcoesPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA" }).map((o) => o.codigo),
    );
  });

  it("código que serve mas não veio na lista do servidor entra como opção própria", () => {
    const curta = { ...SIMPLES_COMPRA, pisCofinsOpcoes: SIMPLES_COMPRA.pisCofinsOpcoes!.filter((o) => o.codigo !== "99") };
    const c = campoPisCofins({ emitente: curta, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "99" } });
    expect(c.valor).toBe("99");
    expect(codigos(c)).toContain("99");
  });

  it("o invariante: toda opção oferecida é aceita pelo juiz do servidor, nos dois regimes e tipos", () => {
    for (const emitente of [SIMPLES_COMPRA, NORMAL_COMPRA, SIMPLES_VENDA, regimeEmitenteDevolucao(null)]) {
      const c = campoPisCofins({ emitente, tipo: emitente.tipoDevolucao ?? null, tributo: "pis", gravado: null });
      for (const o of c.opcoes) {
        expect(checarCstPisCofinsDevolucao({ crt: emitente.crt, tipo: emitente.tipoDevolucao, codigo: o.codigo }).ok, o.codigo).toBe(true);
      }
    }
  });

  it("os grupos do seletor: mais usados, outros, e os do sentido oposto por último", () => {
    const opcoes = opcoesPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA" });
    const g = gruposPisCofins(opcoes, "COMPRA_SAIDA");
    expect(g[0].rotulo).toBe("Mais usados");
    expect(g[0].opcoes[0].codigo).toBe("49");
    // ATUALIZADO (onda 5, decisão 3 do dono): na devolução de COMPRA os códigos
    // de entrada saíram da lista (viraram recusa), então não há mais grupo
    // "Códigos de entrada" nela. O "sentido oposto por último" continua valendo
    // na devolução de VENDA, onde os de saída (o 49 herdado) seguem na lista.
    expect(g.some((x) => x.rotulo.includes("Códigos de entrada"))).toBe(false);
    expect(g.flatMap((x) => x.opcoes).length).toBe(opcoes.length);
    const venda = opcoesPisCofinsDevolucao({ crt: "1", tipo: "VENDA_ENTRADA" });
    const gv = gruposPisCofins(venda, "VENDA_ENTRADA");
    expect(gv[0].rotulo).toBe("Mais usados");
    expect(gv[gv.length - 1].rotulo).toContain("Códigos de saída");
    expect(gv[gv.length - 1].opcoes.map((o) => o.codigo)).toContain("49");
    expect(gv.flatMap((x) => x.opcoes).length).toBe(venda.length);
  });
});

describe("alíquota — vazio NÃO é zero", () => {
  it("campo vazio é 'não informada', nunca 0", () => {
    const a = lerAliquota("", "do PIS");
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.vazia).toBe(true);
      expect(a.motivo).toBe("Informe a alíquota do PIS (de 0 a 100).");
    }
  });

  it("aceita vírgula e recusa fora de 0 a 100", () => {
    expect(lerAliquota("1,65", "do PIS")).toEqual({ ok: true, valor: 1.65 });
    expect(lerAliquota("0", "do PIS")).toEqual({ ok: true, valor: 0 });
    expect(lerAliquota("101", "do PIS").ok).toBe(false);
    expect(lerAliquota("-1", "do PIS").ok).toBe(false);
    expect(lerAliquota("abc", "do PIS").ok).toBe(false);
  });

  it("01 a zero é recusado com o motivo do servidor (alíquota zero é o 06)", () => {
    const campo = campoPisCofins({ emitente: NORMAL_COMPRA, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "01" } });
    const a = aliquotaPisCofins({ campo, tipo: "COMPRA_SAIDA", texto: "0" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.motivo).toContain("06");
    expect(aliquotaPisCofins({ campo, tipo: "COMPRA_SAIDA", texto: "1.65" })).toEqual({ ok: true, valor: 1.65 });
  });

  it("o texto da caixa nasce do número GRAVADO", () => {
    expect(textoDaAliquota(1.65)).toBe("1.65");
    expect(textoDaAliquota(0)).toBe("0");
    expect(textoDaAliquota(undefined)).toBe("");
  });
});

describe("overrideComPisCofins — código e alíquota SEMPRE juntos", () => {
  it("manda o par {cst, p} com a alíquota da caixa", () => {
    expect(overrideComPisCofins(undefined, { tributo: "pis", codigo: "49", p: 0, crt: "1", tipo: "COMPRA_SAIDA" })).toEqual({
      pis: { cst: "49", p: 0 },
    });
  });

  it("normaliza '1' para '01' (o contrato só aceita 2 dígitos)", () => {
    expect(overrideComPisCofins(undefined, { tributo: "cofins", codigo: "1", p: 7.6, crt: "3" })).toEqual({
      cofins: { cst: "01", p: 7.6 },
    });
  });

  it("código sem alíquota (04) vai com p 0, nunca com o número que estava na caixa", () => {
    expect(overrideComPisCofins(undefined, { tributo: "pis", codigo: "04", p: 1.65, crt: "1" })).toEqual({ pis: { cst: "04", p: 0 } });
  });

  it("código que não serve (01 no Simples) não manda nada — nem meio ajuste", () => {
    expect(overrideComPisCofins(undefined, { tributo: "pis", codigo: "01", p: 1.65, crt: "1" })).toBeUndefined();
    expect(overrideComPisCofins({ icms: { csosn: "102", cst: null } }, { tributo: "pis", codigo: "01", p: 1.65, crt: "1" })).toEqual({
      icms: { csosn: "102", cst: null },
    });
  });

  it("código com alíquota e sem número não manda o tributo (o servidor completaria com o gravado)", () => {
    expect(overrideComPisCofins(undefined, { tributo: "pis", codigo: "49", p: undefined, crt: "1" })).toBeUndefined();
  });

  it("não mexe no outro tributo nem no ICMS", () => {
    const antes = { icms: { csosn: "900", cst: null, pICMS: 12 }, cofins: { cst: "49", p: 0 } };
    expect(overrideComPisCofins(antes, { tributo: "pis", codigo: "49", p: 0, crt: "1" })).toEqual({ ...antes, pis: { cst: "49", p: 0 } });
  });
});

describe("recusasPisCofins — um quadro quando o problema é o mesmo", () => {
  const recusado = (tributo: "pis" | "cofins", cst: string) =>
    campoPisCofins({ emitente: SIMPLES_COMPRA, tipo: "COMPRA_SAIDA", tributo, gravado: { cst } });

  it("PIS e COFINS com o mesmo 01: UM quadro, nomeando os dois", () => {
    const r = recusasPisCofins(recusado("pis", "01"), recusado("cofins", "01"));
    expect(r).toHaveLength(1);
    expect(r[0].titulo).toBe("O código do PIS e da COFINS deste item não serve para a sua empresa");
  });

  it("problemas diferentes: dois quadros", () => {
    expect(recusasPisCofins(recusado("pis", "01"), recusado("cofins", "03"))).toHaveLength(2);
  });

  it("nada recusado: nenhum quadro; e a trava da revisão fala dos dois", () => {
    expect(recusasPisCofins(recusado("pis", "49"), recusado("cofins", "04"))).toEqual([]);
    expect(BLOQUEIO_CONFIRMAR_PIS_COFINS).toContain("PIS");
    expect(BLOQUEIO_CONFIRMAR_PIS_COFINS).toContain("COFINS");
  });
});
