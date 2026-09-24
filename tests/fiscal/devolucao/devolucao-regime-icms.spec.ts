/**
 * O campo de ICMS da devolução tem de CONHECER o regime do emitente e recusar o
 * código na hora, com o motivo.
 *
 * Caso real (DLS AUTO PEÇAS, 24/09/2026): emitente do Simples Nacional digitou
 * `00` — CST, de regime normal — no passo de impostos. O campo decidia pelo
 * TAMANHO do que se digita, salvava, e o bloqueio só aparecia na validação do
 * servidor (rejeição 591). Seis rascunhos de devolução abertos e um dia perdido.
 *
 * Invariante que estes testes guardam: a lista oferecida à tela é DERIVADA das
 * mesmas tabelas do construtor (`TAG_POR_CSOSN`/`TAG_POR_CST` + `TagIcmsDevolucao`),
 * e o veredito do campo é o MESMO de `tagIcmsParaDevolucao` — nem mais rígido
 * (bloquearia o que a SEFAZ aceita) nem mais frouxo (deixaria passar a 591).
 *
 * ── Correção de 24/09/2026: são 12 códigos, não 7 ──
 * A primeira versão do seletor oferecia UM código por grupo (102/500/900 e
 * 00/40/60/90). Isso era REGRESSÃO: o construtor escreve o código LITERAL dentro
 * do grupo (`nfe-xml-builder-sefaz.service.ts`), então `<CSOSN>400</CSOSN>` (não
 * tributada) e `<CSOSN>102</CSOSN>` (tributada sem crédito) são notas fiscais
 * DIFERENTES. Com a lista de 7, a própria DLS — Simples, devolvendo peça NÃO
 * tributada — teria de declarar 102 numa peça que não é. Os 12 códigos da
 * allowlist voltaram ao seletor, cada um com rótulo próprio.
 */
import { describe, expect, it } from "vitest";

import {
  CODIGOS_ICMS_DEVOLUCAO,
  ROTULO_ICMS_DEVOLUCAO,
  TAG_POR_CSOSN,
  TAG_POR_CST,
  checarCodigoIcmsDevolucao,
  crtDeRegime,
  familiaDaTag,
  opcoesIcmsDevolucao,
  regimeEmitenteDevolucao,
  tagCompativelComCrt,
  tagIcmsParaDevolucao,
} from "../../../app/fiscal/devolucao/tributacao";
import type { TagIcmsDevolucao } from "../../../app/fiscal/devolucao/tipos";

const codigos = (crt: string | null): string[] => opcoesIcmsDevolucao(crt).map((o) => o.codigo);
const tags = (crt: string | null): string[] => opcoesIcmsDevolucao(crt).map((o) => o.tag);

/** Os 12 da allowlist, na ordem em que o seletor os mostra. */
const CSOSN = ["102", "103", "300", "400", "500", "900"];
const CST = ["00", "40", "41", "50", "60", "90"];

/** Todos os códigos de 1 a 3 dígitos — o campo aceita digitação livre. */
const TODOS_OS_DIGITADOS: string[] = [];
for (let n = 0; n < 1000; n++) {
  TODOS_OS_DIGITADOS.push(String(n), String(n).padStart(2, "0"), String(n).padStart(3, "0"));
}

describe("opcoesIcmsDevolucao — o regime decide a lista", () => {
  it("Simples Nacional (CRT 1) só oferece CSOSN — os SEIS dele", () => {
    expect(codigos("1")).toEqual(CSOSN);
    expect(opcoesIcmsDevolucao("1").every((o) => o.tipo === "CSOSN")).toBe(true);
    expect(tags("1")).toEqual([
      "ICMSSN102", "ICMSSN102", "ICMSSN102", "ICMSSN102", "ICMSSN500", "ICMSSN900",
    ]);
    // Nenhum CST entra na lista do Simples — é a rejeição 591 que a tela evita.
    for (const c of CST) expect(codigos("1")).not.toContain(c);
  });

  it("regime normal (CRT 3) e Simples acima do sublimite (CRT 2) só oferecem CST — os SEIS dele", () => {
    expect(codigos("3")).toEqual(CST);
    expect(codigos("2")).toEqual(CST);
    expect(opcoesIcmsDevolucao("3").every((o) => o.tipo === "CST")).toBe(true);
    expect(tags("3")).toEqual(["ICMS00", "ICMS40", "ICMS40", "ICMS40", "ICMS60", "ICMS90"]);
    // Nenhum CSOSN no regime normal — é a rejeição 590.
    for (const c of CSOSN) expect(codigos("3")).not.toContain(c);
  });

  it("MEI (CRT 4) usa CSOSN, igual ao CRT 1 — é o que familiaDoCrt já faz", () => {
    expect(codigos("4")).toEqual(CSOSN);
    expect(opcoesIcmsDevolucao("4")).toEqual(opcoesIcmsDevolucao("1"));
  });

  it("regime desconhecido oferece os dois — a tela não recusa o que o servidor aceita", () => {
    // Critério de segurança: sem regime cadastrado, `tagIcmsParaDevolucao` aceita
    // as duas famílias. Oferecer nada criaria um beco sem saída NOVO (justamente
    // o defeito que estamos corrigindo); oferecer os dois é idêntico ao servidor.
    expect(codigos(null)).toEqual([...CSOSN, ...CST]);
    expect(opcoesIcmsDevolucao("")).toEqual(opcoesIcmsDevolucao(null));
    expect(opcoesIcmsDevolucao("9")).toEqual(opcoesIcmsDevolucao(null));
    expect(opcoesIcmsDevolucao(undefined)).toEqual(opcoesIcmsDevolucao(null));
  });

  it("cada opção é aceita pelo servidor e compatível com o CRT que a ofereceu", () => {
    for (const crt of ["1", "2", "3", "4", null] as const) {
      for (const o of opcoesIcmsDevolucao(crt)) {
        const tag = tagIcmsParaDevolucao({
          crt,
          cst: o.tipo === "CST" ? o.codigo : null,
          csosn: o.tipo === "CSOSN" ? o.codigo : null,
        });
        expect(tag).toBe(o.tag);
        expect(tagCompativelComCrt(o.tag, crt)).toBe(true);
      }
    }
  });

  it("a lista sai das tabelas do construtor: os 7 grupos, em 12 códigos distintos", () => {
    // Somar um grupo em `TagIcmsDevolucao` sem escrever o rótulo quebra o tsc;
    // sem pôr o código em TAG_POR_CSOSN/TAG_POR_CST quebra AQUI.
    const grupos = Object.keys(ROTULO_ICMS_DEVOLUCAO) as TagIcmsDevolucao[];
    expect(grupos).toHaveLength(7);
    // Todo grupo aparece, e nenhum grupo a mais.
    expect([...new Set(tags(null))].sort()).toEqual([...grupos].sort());
    // Os 12 códigos são OPÇÕES próprias — e é aqui que a regressão morre: com um
    // código por grupo isto valeria 7, e 103/300/400/41/50 teriam sumido da tela.
    expect(codigos(null)).toHaveLength(12);
    expect(new Set(codigos(null)).size).toBe(12);
    // Grupo com mais de um código aparece mais de uma vez — 102/103/300/400
    // montam todos `ICMSSN102`, mas continuam sendo notas diferentes.
    expect(tags(null).filter((t) => t === "ICMSSN102")).toHaveLength(4);
    expect(tags(null).filter((t) => t === "ICMS40")).toHaveLength(3);
  });

  it("cada código tem rótulo PRÓPRIO em português, com o número primeiro", () => {
    const vistos = new Set<string>();
    for (const o of opcoesIcmsDevolucao(null)) {
      expect(o.rotulo.startsWith(`${o.codigo} — `)).toBe(true);
      expect(o.rotulo.length).toBeGreaterThan(o.codigo.length + 12);
      // Rótulo repetido = dois códigos explicados com a mesma frase, que é o
      // mesmo que não distingui-los. O 400 tem de dizer "não tributada".
      expect(vistos.has(o.rotulo), `rótulo repetido em ${o.codigo}`).toBe(false);
      vistos.add(o.rotulo);
    }
    // `ROTULO_ICMS_DEVOLUCAO` (compatibilidade) continua sendo um por grupo: o
    // do PRIMEIRO código dele.
    for (const tag of Object.keys(ROTULO_ICMS_DEVOLUCAO) as TagIcmsDevolucao[]) {
      const primeiro = opcoesIcmsDevolucao(null).find((o) => o.tag === tag);
      expect(ROTULO_ICMS_DEVOLUCAO[tag]).toBe(primeiro?.rotulo);
    }
  });

  it("exigeValores marca só os grupos que levam base e alíquota", () => {
    const comValores = opcoesIcmsDevolucao(null).filter((o) => o.exigeValores).map((o) => o.tag);
    // Os mesmos de emissao.ts e do montador SEFAZ.
    expect([...comValores].sort()).toEqual(["ICMS00", "ICMS90", "ICMSSN900"]);
  });
});

describe("regimeEmitenteDevolucao — o que vai no DevolucaoDetalhe.emitente", () => {
  it("SIMPLES → CRT 1, CSOSN, e a ajuda cita os códigos da própria lista", () => {
    const e = regimeEmitenteDevolucao("SIMPLES");
    expect(e.crt).toBe("1");
    expect(e.crt).toBe(crtDeRegime("SIMPLES"));
    expect(e.regimeTributario).toBe("SIMPLES");
    expect(e.tipoCodigoIcms).toBe("CSOSN");
    expect(e.icmsOpcoes.map((o) => o.codigo)).toEqual(CSOSN);
    expect(e.ajuda).toContain("Simples Nacional");
    expect(e.ajuda).toContain("CSOSN");
    expect(e.ajuda).toContain("3 dígitos");
    // A `ajuda` é o ÚNICO lugar que ainda enumera: aparece uma vez no topo, é a
    // orientação ("no seu regime o código é este daqui") e nunca mistura as duas
    // famílias. As recusas, que se repetem por item, não enumeram mais.
    expect(e.ajuda).toContain("102, 103, 300, 400, 500 ou 900");
    // Uma família por vez: a ajuda do Simples nem nomeia o CST.
    expect(e.ajuda).not.toContain("CST");
  });

  it("LUCRO_PRESUMIDO e LUCRO_REAL → CRT 3, CST", () => {
    for (const regime of ["LUCRO_PRESUMIDO", "LUCRO_REAL"]) {
      const e = regimeEmitenteDevolucao(regime);
      expect(e.crt).toBe("3");
      expect(e.tipoCodigoIcms).toBe("CST");
      expect(e.icmsOpcoes.map((o) => o.codigo)).toEqual(CST);
      expect(e.ajuda).toContain("CST");
      expect(e.ajuda).toContain("2 dígitos");
      expect(e.ajuda).toContain("00, 40, 41, 50, 60 ou 90");
      expect(e.ajuda).not.toContain("CSOSN");
    }
  });

  it("regime nulo, vazio ou desconhecido: crt null, os dois tipos e aviso de confirmar", () => {
    for (const regime of [null, undefined, "", "   ", "MEI", "IMUNE"]) {
      const e = regimeEmitenteDevolucao(regime);
      expect(e.crt).toBeNull();
      expect(e.tipoCodigoIcms).toBeNull();
      expect(e.icmsOpcoes).toHaveLength(12);
      expect(e.ajuda).toContain("não está cadastrado");
      expect(e.ajuda).toContain("contador");
    }
    expect(regimeEmitenteDevolucao("   ").regimeTributario).toBeNull();
    expect(regimeEmitenteDevolucao("MEI").regimeTributario).toBe("MEI");
  });

  it("a lista entregue é cópia: mexer nela não contamina a próxima chamada", () => {
    const e = regimeEmitenteDevolucao("SIMPLES");
    e.icmsOpcoes.pop();
    e.icmsOpcoes[0].rotulo = "adulterado";
    expect(regimeEmitenteDevolucao("SIMPLES").icmsOpcoes.map((o) => o.codigo)).toEqual(CSOSN);
    expect(regimeEmitenteDevolucao("SIMPLES").icmsOpcoes[0].rotulo).toBe(ROTULO_ICMS_DEVOLUCAO.ICMSSN102);
  });
});

describe("checarCodigoIcmsDevolucao — recusa na hora, com o motivo", () => {
  it("o caso da DLS: Simples + `00` recusa dizendo que 00 é do regime normal", () => {
    const r = checarCodigoIcmsDevolucao({ crt: crtDeRegime("SIMPLES"), codigo: "00" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("deveria recusar");
    expect(r.causa).toBe("REGIME");
    expect(r.motivo).toContain("00 é CST");
    expect(r.motivo).toContain("regime normal");
    expect(r.motivo).toContain("Simples Nacional");
    expect(r.motivo).toContain("CSOSN, de 3 dígitos");
    // A recusa manda para a LISTA em vez de despejar os seis números: o campo é
    // um seletor, e lá cada código vem com o que ele significa.
    expect(r.motivo).toContain("escolha um na lista");
    expect(r.motivo).not.toContain("102, 103, 300, 400, 500 ou 900");
  });

  it("o espelho: regime normal + CSOSN recusa citando o CST", () => {
    const r = checarCodigoIcmsDevolucao({ crt: "3", codigo: "102" });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.causa).toBe("REGIME");
    expect(r.motivo).toContain("102 é CSOSN");
    expect(r.motivo).toContain("CST, de 2 dígitos");
    expect(r.motivo).toContain("escolha um na lista");
    expect(r.motivo).not.toContain("00, 40, 41, 50, 60 ou 90");
  });

  it("aceita os códigos do próprio regime e devolve o grupo do construtor", () => {
    expect(checarCodigoIcmsDevolucao({ crt: "1", codigo: "102" })).toEqual({
      ok: true, codigo: "102", tipo: "CSOSN", tag: "ICMSSN102",
    });
    expect(checarCodigoIcmsDevolucao({ crt: "1", codigo: "500" })).toEqual({
      ok: true, codigo: "500", tipo: "CSOSN", tag: "ICMSSN500",
    });
    expect(checarCodigoIcmsDevolucao({ crt: "3", codigo: "00" })).toEqual({
      ok: true, codigo: "00", tipo: "CST", tag: "ICMS00",
    });
    expect(checarCodigoIcmsDevolucao({ crt: "4", codigo: "900" }).ok).toBe(true);
  });

  it("103/300/400 e 41/50 são aceitos E oferecidos — não são apelidos de 102 e 40", () => {
    // O construtor escreve o código literal, então cada um destes é uma nota
    // fiscal diferente. Chamá-los de "apelido" e esconder do seletor foi a
    // regressão: a DLS, do Simples, devolvendo peça NÃO tributada usa o 400.
    for (const c of ["103", "300", "400"]) {
      expect(checarCodigoIcmsDevolucao({ crt: "1", codigo: c })).toMatchObject({ ok: true, tag: "ICMSSN102" });
      expect(codigos("1")).toContain(c);
    }
    for (const c of ["41", "50"]) {
      expect(checarCodigoIcmsDevolucao({ crt: "3", codigo: c })).toMatchObject({ ok: true, tag: "ICMS40" });
      expect(codigos("3")).toContain(c);
    }
    // E o rótulo de cada um diz outra coisa — senão o seletor mostraria quatro
    // linhas com a mesma explicação.
    const noSeletor = (c: string) => opcoesIcmsDevolucao("1").find((o) => o.codigo === c)?.rotulo ?? "";
    expect(noSeletor("400")).not.toBe(noSeletor("102"));
    expect(noSeletor("400")).toContain("Não tributada");
  });

  it("código da família certa mas fora da allowlist: diz que o Dexo não emite", () => {
    const r = checarCodigoIcmsDevolucao({ crt: "1", codigo: "101" });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.causa).toBe("NAO_SUPORTADO");
    expect(r.motivo).toContain("CSOSN 101");
    expect(r.motivo).toContain("Escolha na lista");

    const s = checarCodigoIcmsDevolucao({ crt: "3", codigo: "20" });
    if (s.ok) throw new Error("deveria recusar");
    expect(s.causa).toBe("NAO_SUPORTADO");
    expect(s.motivo).toContain("CST 20");
  });

  it("vazio e formato", () => {
    for (const v of ["", "   ", null, undefined]) {
      const r = checarCodigoIcmsDevolucao({ crt: "1", codigo: v });
      if (r.ok) throw new Error("deveria recusar");
      expect(r.causa).toBe("VAZIO");
      expect(r.motivo).toContain("Informe");
    }
    for (const v of ["0102", "1a", "CSOSN 102", "-1", "1.0"]) {
      const r = checarCodigoIcmsDevolucao({ crt: "1", codigo: v });
      if (r.ok) throw new Error(`deveria recusar ${v}`);
      expect(r.causa).toBe("FORMATO");
      expect(r.motivo).toContain("dígitos");
    }
  });

  it("normaliza o zero à esquerda do CST e apara o espaço", () => {
    expect(checarCodigoIcmsDevolucao({ crt: "3", codigo: "0" })).toEqual({
      ok: true, codigo: "00", tipo: "CST", tag: "ICMS00",
    });
    expect(checarCodigoIcmsDevolucao({ crt: "3", codigo: " 60 " })).toMatchObject({ ok: true, codigo: "60" });
    // "0" no Simples continua recusado, e pelo motivo do REGIME.
    expect(checarCodigoIcmsDevolucao({ crt: "1", codigo: "0" })).toMatchObject({ causa: "REGIME", codigo: "00" });
  });

  it("sem regime cadastrado aceita os dois, igual ao servidor", () => {
    expect(checarCodigoIcmsDevolucao({ crt: null, codigo: "00" }).ok).toBe(true);
    expect(checarCodigoIcmsDevolucao({ crt: null, codigo: "102" }).ok).toBe(true);
    const r = checarCodigoIcmsDevolucao({ crt: null, codigo: "101" });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.causa).toBe("NAO_SUPORTADO");
    expect(r.motivo).toContain("CSOSN 101");
    expect(r.motivo).toContain("Escolha na lista");
    // Este era o PIOR caso da frase enumerada: sem regime cadastrado o servidor
    // aceita os doze, e a recusa virava "102, 103, 300, 400, 500, 900, 00, 40,
    // 41, 50, 60 ou 90" — parede de número, misturando 3 e 2 dígitos, num item
    // só. Nenhuma sequência dessas sobrou.
    expect(r.motivo).not.toMatch(/\d, \d/);
    expect(r.motivo.length).toBeLessThan(120);
  });

  it("NUNCA diverge do servidor: para todo código digitável e todo CRT", () => {
    // A garantia central — se `tagIcmsParaDevolucao` mudar, o campo muda junto.
    for (const crt of ["1", "2", "3", "4", null] as const) {
      for (const digitado of TODOS_OS_DIGITADOS) {
        const r = checarCodigoIcmsDevolucao({ crt, codigo: digitado });
        const tipo = digitado.length === 3 ? "CSOSN" : "CST";
        const codigo = tipo === "CST" ? digitado.padStart(2, "0") : digitado;
        const esperada = tagIcmsParaDevolucao({
          crt,
          cst: tipo === "CST" ? codigo : null,
          csosn: tipo === "CSOSN" ? codigo : null,
        });
        expect(r.ok).toBe(esperada !== null);
        if (r.ok) expect(r.tag).toBe(esperada);
        else expect(r.motivo.length).toBeGreaterThan(20);
      }
    }
  });

  it("todo código recusado por REGIME é aceito no OUTRO regime", () => {
    for (const crt of ["1", "3"] as const) {
      const oposto = crt === "1" ? "3" : "1";
      for (const digitado of TODOS_OS_DIGITADOS) {
        const r = checarCodigoIcmsDevolucao({ crt, codigo: digitado });
        if (!r.ok && r.causa === "REGIME") {
          expect(checarCodigoIcmsDevolucao({ crt: oposto, codigo: digitado }).ok).toBe(true);
        }
      }
    }
  });
});

/**
 * A garantia que FALTAVA — e é por não existir que a lista de 7 passou.
 *
 * `TAG_POR_CSOSN`/`TAG_POR_CST` são o que o SERVIDOR aceita; `CODIGOS_ICMS_DEVOLUCAO`
 * é o que a TELA oferece. Nada amarrava os dois: dá para escrever rótulo só para
 * 102/500/900 e os outros seis somem do seletor em silêncio, tsc verde, suíte
 * verde — que foi exatamente o que aconteceu. Os dois sentidos, agora presos.
 *
 * ⚠️ O sentido "toda opção é aceita" precisa olhar `CODIGOS_ICMS_DEVOLUCAO`, não
 * `opcoesIcmsDevolucao`: `TODAS_AS_OPCOES` FILTRA pelo que a allowlist aceita,
 * então um rótulo órfão nunca chega a virar opção — ele é DESCARTADO em silêncio,
 * e um teste que só varresse as opções passaria sempre (tautologia).
 */
describe("sincronia servidor ⇄ seletor: nenhum código aceito fica fora, nenhum rótulo fica órfão", () => {
  const POR_REGIME = [
    { tipo: "CSOSN" as const, crt: "1", aceitos: TAG_POR_CSOSN },
    { tipo: "CST" as const, crt: "3", aceitos: TAG_POR_CST },
  ];

  it("→ todo código que o servidor aceita é oferecido ao regime dele, com a mesma tag", () => {
    // Quebra se alguém somar um código a TAG_POR_CSOSN/TAG_POR_CST e esquecer o
    // rótulo em CODIGOS_ICMS_DEVOLUCAO.
    for (const { tipo, crt, aceitos } of POR_REGIME) {
      const oferecidas = new Map(opcoesIcmsDevolucao(crt).map((o) => [o.codigo, o]));
      for (const [codigo, tag] of Object.entries(aceitos)) {
        const o = oferecidas.get(codigo);
        expect(o, `${tipo} ${codigo}: o servidor aceita e o seletor NÃO oferece`).toBeDefined();
        expect(o?.tag).toBe(tag);
        expect(o?.tipo).toBe(tipo);
      }
    }
  });

  it("← todo código com rótulo é aceito pelo servidor, na tag em que foi escrito", () => {
    // Quebra se alguém escrever um rótulo para código fora da allowlist, tirar um
    // código da allowlist deixando o rótulo, ou pôr o rótulo na tag errada.
    for (const tag of Object.keys(CODIGOS_ICMS_DEVOLUCAO) as TagIcmsDevolucao[]) {
      const aceitos = familiaDaTag(tag) === "SN" ? TAG_POR_CSOSN : TAG_POR_CST;
      for (const { codigo } of CODIGOS_ICMS_DEVOLUCAO[tag]) {
        expect(aceitos[codigo], `rótulo de ${codigo} em ${tag}: o servidor não aceita assim`).toBe(tag);
      }
    }
  });

  it("← e nenhuma opção do seletor escapa da allowlist (o filtro pode sumir um dia)", () => {
    for (const { tipo, crt, aceitos } of POR_REGIME) {
      for (const o of opcoesIcmsDevolucao(crt)) {
        expect(o.tipo).toBe(tipo);
        expect(aceitos[o.codigo], `${tipo} ${o.codigo} no seletor e FORA da allowlist`).toBe(o.tag);
      }
    }
  });

  it("a conta fecha dos dois lados — sem código sobrando nem faltando", () => {
    for (const { crt, aceitos } of POR_REGIME) {
      expect([...codigos(crt)].sort()).toEqual(Object.keys(aceitos).sort());
    }
    expect([...codigos(null)].sort()).toEqual(
      [...Object.keys(TAG_POR_CSOSN), ...Object.keys(TAG_POR_CST)].sort(),
    );
  });

  it("e o que o seletor oferece é o que `checarCodigoIcmsDevolucao` aceita — os dois sentidos", () => {
    // Fecha o triângulo: tabela → seletor → veredito do campo.
    for (const { crt, aceitos } of POR_REGIME) {
      for (const o of opcoesIcmsDevolucao(crt)) {
        expect(checarCodigoIcmsDevolucao({ crt, codigo: o.codigo })).toEqual({
          ok: true, codigo: o.codigo, tipo: o.tipo, tag: o.tag,
        });
      }
      for (const codigo of Object.keys(aceitos)) {
        expect(checarCodigoIcmsDevolucao({ crt, codigo }).ok, `${crt}/${codigo}`).toBe(true);
      }
    }
  });
});
