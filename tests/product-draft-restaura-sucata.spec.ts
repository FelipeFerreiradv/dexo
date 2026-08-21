// Restaurar um rascunho tem de devolver TAMBÉM o vínculo com a sucata.
//
// O DEFEITO. O rascunho gravava a sucata escolhida — há um efeito dedicado só
// para isso, porque ela vive fora do react-hook-form — e a restauração nunca
// lia esse campo. Escrita morta. Voltavam marca, modelo, ano, versão e o texto
// do veículo, todos campos do formulário; ficava de fora o vínculo, o único que
// não alimenta nenhum outro campo visível. A tela parecia completa, e a peça
// nascia sem lote: fora da contagem e dos valores da sucata.
//
// POR QUE O REMÉDIO INGÊNUO SERIA PIOR. O modal de criação é um `<form>`, e ali
// o Radix mantém um `<select>` NATIVO espelho. Valor sem `<option>` casando é
// recusado pelo browser, que cai na PRIMEIRA opção — "Nenhuma sucata" — e o
// Radix devolve isso pelo `onValueChange`. Esse ramo APAGA marca, modelo, ano,
// versão e veículo de origem. Chamar `setSelectedScrap` direto trocaria a perda
// de um campo pela perda de cinco.
//
// Daí a decisão em dois passos, que é o que este spec trava.

import { describe, it, expect } from "vitest";

import {
  decidirRestauracaoDaSucata,
  type SucataDoSeletor,
} from "../app/produtos/lib/scrap-draft-restore";
import {
  hasMeaningfulContent,
  parseSnapshot,
  serializeProductForm,
} from "../app/produtos/lib/product-form-snapshot";

const T0 = 1_750_000_000_000;

const FUSION: SucataDoSeletor = {
  id: "cmrpmx6f0039y18i6s5c9f6gy",
  brand: "FORD",
  model: "FUSION",
  year: "2009",
  plate: "HHW1478",
};

describe("decidirRestauracaoDaSucata — a opção antes do valor", () => {
  it("lote na lista ⇒ aplica de uma vez", () => {
    const acao = decidirRestauracaoDaSucata({ id: FUSION.id }, [FUSION]);
    expect(acao).toEqual({ tipo: "aplicar", sucata: FUSION });
  });

  it("os dados aplicados vêm da LISTA, não do rascunho", () => {
    // A lista é o que o servidor acabou de responder; o rascunho pode ter
    // dormido um dia inteiro (o TTL) com a placa antiga.
    const doRascunho = { ...FUSION, plate: "PLACA-VELHA" };
    const acao = decidirRestauracaoDaSucata(doRascunho, [FUSION]);
    expect(acao).toEqual({ tipo: "aplicar", sucata: FUSION });
  });

  it("REGRESSÃO: fora da lista, NÃO aplica — registra a opção primeiro", () => {
    // O coração da correção. Aplicar aqui faria o `<select>` nativo recusar o
    // valor, cair em "Nenhuma sucata" e apagar cinco campos.
    const acao = decidirRestauracaoDaSucata(FUSION, []);
    expect(acao.tipo).toBe("registrar-opcao");
    expect(acao.tipo === "registrar-opcao" && acao.opcao).toEqual(FUSION);
  });

  it("a sequência completa: registrar e só então aplicar", () => {
    // Simula os dois commits do efeito.
    const lista: SucataDoSeletor[] = [];
    const passo1 = decidirRestauracaoDaSucata(FUSION, lista);
    expect(passo1.tipo).toBe("registrar-opcao");
    if (passo1.tipo !== "registrar-opcao") throw new Error("passo1");

    const listaDepois = [passo1.opcao, ...lista];
    const passo2 = decidirRestauracaoDaSucata(FUSION, listaDepois);
    expect(passo2).toEqual({ tipo: "aplicar", sucata: FUSION });
  });

  it("rascunho ANTIGO (só id) e fora da lista ⇒ espera, não inventa rótulo", () => {
    // Formato anterior a 21/08/2026. Sem marca e modelo não há opção para
    // desenhar; o TTL de 24h aposenta esses rascunhos sozinho.
    expect(decidirRestauracaoDaSucata({ id: "so-o-id" }, [])).toEqual({
      tipo: "esperar",
    });
  });

  it("rascunho antigo mas o lote ESTÁ na lista ⇒ aplica mesmo assim", () => {
    expect(decidirRestauracaoDaSucata({ id: FUSION.id }, [FUSION])).toEqual({
      tipo: "aplicar",
      sucata: FUSION,
    });
  });

  it("LOTE TRAVADO manda: rascunho não troca a peça de sucata", () => {
    // No fluxo "Adicionar peça" do detalhe do lote a sucata vem da porta de
    // entrada, e o seletor nem é desenhado. O rascunho desse fluxo é escopado
    // apenas como "scrap", SEM o id do lote — então um rascunho começado no
    // lote A pode ser oferecido dentro do lote B. Restaurar ali trocaria a
    // peça de lote sem ninguém pedir.
    const OUTRO_LOTE = { ...FUSION, id: "outro-lote" };
    expect(decidirRestauracaoDaSucata(OUTRO_LOTE, [FUSION], true)).toEqual({
      tipo: "esperar",
    });
    // Controle: sem a trava, a mesma entrada agiria.
    expect(decidirRestauracaoDaSucata(OUTRO_LOTE, [FUSION], false).tipo).toBe(
      "registrar-opcao",
    );
  });

  it("sem nada pendente é inerte", () => {
    expect(decidirRestauracaoDaSucata(null, [FUSION])).toEqual({
      tipo: "esperar",
    });
    expect(decidirRestauracaoDaSucata(undefined, [FUSION])).toEqual({
      tipo: "esperar",
    });
    expect(decidirRestauracaoDaSucata({ id: "" }, [FUSION])).toEqual({
      tipo: "esperar",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const rascunho = (over: Record<string, unknown> = {}) =>
  serializeProductForm({
    values: { stock: 1, ...over },
    compatibilities: [],
    scrap: FUSION,
    defaultStock: 1,
    now: T0,
  });

/** O caminho real: o rascunho passa por JSON no localStorage. */
const idaEVolta = (s: unknown) => parseSnapshot(JSON.parse(JSON.stringify(s)));

describe("o rascunho sobrevive à ida ao localStorage", () => {
  it("a sucata volta com o veículo, não só com o id", () => {
    const lido = idaEVolta(rascunho());
    expect(lido?.scrap).toEqual(FUSION);
  });

  it("REGRESSÃO: `defaultStock` deixava de voltar", () => {
    expect(idaEVolta(rascunho())?.defaultStock).toBe(1);
  });

  it("REGRESSÃO: a MESMA pergunta tinha DUAS respostas", () => {
    // `hasMeaningfulContent` compara o estoque com o padrão do tenant para não
    // oferecer "continuar de onde parou?" sobre um formulário intocado — num
    // desmanche o padrão é 1, porque cada peça é única.
    //
    // Como `defaultStock` sumia na volta do localStorage, o padrão virava 0 e a
    // mesma função respondia diferente conforme o rascunho viesse da memória ou
    // do disco. Uma função pura que mudava de opinião por causa do transporte.
    const emMemoria = rascunho();
    const doDisco = idaEVolta(emMemoria);

    expect(hasMeaningfulContent(emMemoria)).toBe(false);
    expect(doDisco).not.toBeNull();
    expect(hasMeaningfulContent(doDisco!)).toBe(
      hasMeaningfulContent(emMemoria),
    );
  });

  it("e continua dizendo SIM quando há trabalho de verdade", () => {
    // Controle: sem isto, o caso acima passaria com uma função que responde
    // "false" para tudo.
    const comNome = rascunho({ name: "Farol dianteiro direito" });
    expect(hasMeaningfulContent(comNome)).toBe(true);
    expect(hasMeaningfulContent(idaEVolta(comNome)!)).toBe(true);
  });

  it("estoque acima do padrão do tenant conta como trabalho", () => {
    const comEstoque = serializeProductForm({
      values: { stock: 4 },
      compatibilities: [],
      defaultStock: 1,
      now: T0,
    });
    expect(hasMeaningfulContent(comEstoque)).toBe(true);
    expect(hasMeaningfulContent(idaEVolta(comEstoque)!)).toBe(true);
  });
});

describe("a sucata lida do localStorage é dado de FORA", () => {
  it("sem id utilizável ⇒ nenhuma sucata", () => {
    for (const lixo of [{}, { id: "" }, { id: "   " }, { id: 42 }, null, 7]) {
      const s = { ...rascunho(), scrap: lixo };
      expect(idaEVolta(s)?.scrap).toBeNull();
    }
  });

  it("campos que não são texto são descartados, não renderizados", () => {
    const s = {
      ...rascunho(),
      scrap: {
        id: "x",
        brand: { nao: "sou texto" },
        model: 9,
        plate: "ABC1234",
      },
    };
    const lido = idaEVolta(s);
    expect(lido?.scrap?.id).toBe("x");
    expect(lido?.scrap?.brand).toBeUndefined();
    expect(lido?.scrap?.model).toBeUndefined();
    expect(lido?.scrap?.plate).toBe("ABC1234");
  });

  it("e uma sucata sem marca/modelo não vira opção do seletor", () => {
    // Fecha o ciclo com o módulo de decisão: lixo saneado não pode acabar
    // desenhado como `<option>`.
    const lido = idaEVolta({ ...rascunho(), scrap: { id: "x", brand: 1 } });
    expect(decidirRestauracaoDaSucata(lido?.scrap, [])).toEqual({
      tipo: "esperar",
    });
  });
});
