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
  opcoesComSucataRestaurada,
  sucataParaRascunho,
  type SucataDoSeletor,
} from "../app/produtos/lib/scrap-draft-restore";
import {
  hasMeaningfulContent,
  parseSnapshot,
  serializeProductForm,
} from "../app/produtos/lib/product-form-snapshot";

const T0 = 1_750_000_000_000;

// O caso real do cliente. `version` entra de propósito: sem ela nenhum fixture
// exercitaria esse campo, e um erro que o deixasse de fora sobreviveria à suíte.
const FUSION: SucataDoSeletor = {
  id: "cmrpmx6f0039y18i6s5c9f6gy",
  brand: "FORD",
  model: "FUSION",
  year: "2009",
  version: "TITANIUM",
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

describe("sucataParaRascunho — o que NÃO pode ir para o localStorage", () => {
  /** O que `GET /scraps` realmente devolve, além dos seis campos do tipo. */
  const DA_API = {
    ...FUSION,
    cost: 18500,
    extraCosts: 300,
    paymentMethod: "PIX",
    chassis: "9BWZZZ377VT004251",
    renavam: "00123456789",
    engineNumber: "CHT-1234",
    supplierCnpj: "12345678000199",
    nfeNumber: "000123456",
    icmsValue: 1234.56,
  } as unknown as SucataDoSeletor;

  it("REGRESSÃO: custo do lote e documentos do veículo ficam de fora", () => {
    // O modelo `Scrap` tem 44 colunas e a rota de listagem só `omit`-a algumas.
    // O tipo `SucataDoSeletor` descreve seis campos, mas TIPO NÃO FILTRA EM
    // TEMPO DE EXECUÇÃO — o objeto que circula é o que a API mandou. Guardar
    // `selectedScrap` direto no rascunho colocaria o custo de aquisição e os
    // documentos do veículo no navegador, por 24 horas.
    const guardado = sucataParaRascunho(DA_API);

    expect(Object.keys(guardado!).sort()).toEqual([
      "brand",
      "id",
      "model",
      "plate",
      "version",
      "year",
    ]);

    const bruto = JSON.stringify(guardado);
    for (const segredo of [
      "18500",
      "9BWZZZ377VT004251",
      "00123456789",
      "12345678000199",
      "1234.56",
    ]) {
      expect(bruto).not.toContain(segredo);
    }
  });

  it("uma COLUNA NOVA do modelo nasce fora do rascunho", () => {
    // O ponto da lista de permissão: acrescentar `custoOculto` ao `Scrap`
    // amanhã não pode empurrá-lo para o localStorage sozinho.
    const comColunaNova = {
      ...FUSION,
      custoOculto: "AINDA-NAO-EXISTE-MAS-VAI",
    } as unknown as SucataDoSeletor;
    const guardado = sucataParaRascunho(comColunaNova);
    expect(guardado).not.toHaveProperty("custoOculto");
    expect(JSON.stringify(guardado)).not.toContain("AINDA-NAO-EXISTE");
  });

  it("o que sobra ainda é suficiente para desenhar a opção", () => {
    // Controle: cortar demais quebraria a restauração tão em silêncio quanto o
    // vazamento — sem marca e modelo, `decidirRestauracaoDaSucata` desiste.
    const guardado = sucataParaRascunho(DA_API);
    expect(decidirRestauracaoDaSucata(guardado, []).tipo).toBe(
      "registrar-opcao",
    );
  });

  it("sem sucata selecionada, nada é guardado", () => {
    expect(sucataParaRascunho(null)).toBeNull();
    expect(sucataParaRascunho(undefined)).toBeNull();
    expect(sucataParaRascunho({ id: "" } as SucataDoSeletor)).toBeNull();
  });
});

describe("opcoesComSucataRestaurada — a opção não pode ser varrida", () => {
  const OUTRA: SucataDoSeletor = { id: "b", brand: "GM", model: "ONIX" };

  it("REGRESSÃO: trocar a lista inteira NÃO remove a sucata restaurada", () => {
    // O defeito que quase passou. A primeira versão desta correção EMPURRAVA a
    // opção para dentro de `availableScraps`. Só que o fetch de `/scraps` faz
    // `setAvailableScraps(lista || [])` — substitui o estado inteiro. E a
    // ordem real favorece o desastre: a pergunta "restaurar?" nasce da leitura
    // do localStorage, imediata, e costuma aparecer ANTES de a requisição
    // voltar. A resposta chegava, varria a opção injetada, o valor ficava sem
    // `<option>`, o `<select>` nativo caía em "Nenhuma sucata" e o eco apagava
    // marca, modelo, ano, versão e veículo.
    //
    // Derivando a cada render, a opção sobrevive a qualquer substituição.
    const antesDoFetch = opcoesComSucataRestaurada([], FUSION);
    expect(antesDoFetch.map((s) => s.id)).toEqual([FUSION.id]);

    // O fetch responde com OUTRA lista, sem o lote restaurado.
    const depoisDoFetch = opcoesComSucataRestaurada([OUTRA], FUSION);
    expect(depoisDoFetch.map((s) => s.id)).toEqual([FUSION.id, OUTRA.id]);
  });

  it("não duplica quando o servidor devolve o mesmo lote", () => {
    const r = opcoesComSucataRestaurada([OUTRA, FUSION], FUSION);
    expect(r).toEqual([OUTRA, FUSION]);
    expect(r.filter((s) => s.id === FUSION.id)).toHaveLength(1);
  });

  it("sem sucata restaurada, devolve a lista intocada", () => {
    const lista = [OUTRA];
    expect(opcoesComSucataRestaurada(lista, null)).toBe(lista);
    expect(opcoesComSucataRestaurada(lista, undefined)).toBe(lista);
  });

  it("o seletor aparece mesmo com o servidor devolvendo vazio", () => {
    // O bloco só é desenhado quando há opções. Sem esta derivação, um tenant
    // sem lotes `AVAILABLE` restauraria o rascunho e não veria seletor nenhum
    // — nem o vínculo que acabou de voltar.
    expect(opcoesComSucataRestaurada([], FUSION)).toHaveLength(1);
    expect(opcoesComSucataRestaurada([], null)).toHaveLength(0);
  });

  it("e a decisão enxerga a opção derivada, fechando o ciclo", () => {
    const derivadas = opcoesComSucataRestaurada([], FUSION);
    expect(decidirRestauracaoDaSucata(FUSION, derivadas)).toEqual({
      tipo: "aplicar",
      sucata: FUSION,
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

  it("`defaultStock` que não é número vira null, e não entra na conta", () => {
    // O valor vem do localStorage, então é entrada de fora. Sem o saneamento,
    // um `"1"` (string) ou um `NaN` chegaria a `hasMeaningfulContent`, onde é
    // comparado com `stock` por `!==` — e `1 !== "1"` é verdadeiro, o que
    // ressuscitaria exatamente o falso "continuar de onde parou?" que o campo
    // existe para evitar.
    for (const lixo of ["1", NaN, Infinity, null, {}, "abc"]) {
      const s = { ...rascunho(), defaultStock: lixo };
      expect(idaEVolta(s)?.defaultStock).toBeNull();
    }
    // Zero é valor legítimo e não pode ser confundido com ausência.
    expect(idaEVolta({ ...rascunho(), defaultStock: 0 })?.defaultStock).toBe(0);
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
