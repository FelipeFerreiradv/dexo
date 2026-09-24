import { describe, expect, it } from "vitest";
import {
  avisoEmissao,
  ehDevolucao,
  resolverAmbienteEmissao,
  type AvisoEmissao,
} from "../../app/notas-fiscais/lib/nfe-aviso-emissao";

// Aviso do ultimo passo do wizard ("Finalizar"). O defeito de origem: o bloco
// afirmava "ambiente de homologacao" escrito fixo, sem olhar dado nenhum — e a
// DLS AUTO PECAS, que emite em PRODUCAO (ontem autorizou notas de R$ 12.000),
// lia isso no segundo antes de clicar.
//
// O texto FIXO que existia no step-finalizar.tsx, palavra por palavra. Serve de
// sentinela: se alguem voltar o componente para o texto cru, o ambiente de
// producao passa a exibi-lo e os testes abaixo quebram.
const TEXTO_FIXO_ANTIGO =
  'Ao clicar em "Emitir NF-e", a nota será validada, numerada e enviada para autorização na SEFAZ em ambiente de homologação.';

const texto = (a: AvisoEmissao) => [a.titulo, ...a.linhas].join(" ").toLowerCase();

const SINAIS_DESCONHECIDOS = [undefined, null, "", "   ", "PRODUÇÃO", "sandbox", "2", "HOMOLOGACAO_X"];

describe("resolverAmbienteEmissao: producao manda, duvida nunca vira homologacao", () => {
  it("config e a autoridade quando conhecida", () => {
    expect(resolverAmbienteEmissao({ ambienteConfig: "PRODUCAO" })).toBe("PRODUCAO");
    expect(resolverAmbienteEmissao({ ambienteConfig: "HOMOLOGACAO" })).toBe("HOMOLOGACAO");
    // Caixa e espaco nao sao sinal novo: "producao" e "PRODUCAO" sao o mesmo.
    expect(resolverAmbienteEmissao({ ambienteConfig: " producao " })).toBe("PRODUCAO");
    expect(resolverAmbienteEmissao({ ambienteConfig: "homologacao" })).toBe("HOMOLOGACAO");
  });

  it("DLS: rascunho ANTIGO com ambiente=HOMOLOGACAO + config em PRODUCAO ⇒ PRODUCAO", () => {
    // Este e o caso real. A emissao usa config.ambiente e ate REGRAVA a linha;
    // o `ambiente` do rascunho e so o do dia em que ele nasceu. Se este caso
    // resolvesse HOMOLOGACAO, a tela continuaria mentindo — com cara de dado.
    expect(
      resolverAmbienteEmissao({ ambienteConfig: "PRODUCAO", ambienteRascunho: "HOMOLOGACAO" }),
    ).toBe("PRODUCAO");
  });

  it("rascunho sustenta o aviso quando a config nao pode ser lida (GET falhou)", () => {
    expect(resolverAmbienteEmissao({ ambienteConfig: null, ambienteRascunho: "PRODUCAO" })).toBe("PRODUCAO");
    expect(resolverAmbienteEmissao({ ambienteConfig: null, ambienteRascunho: "HOMOLOGACAO" })).toBe("HOMOLOGACAO");
  });

  it("sinal conhecido em PRODUCAO vence em qualquer combinacao", () => {
    expect(resolverAmbienteEmissao({ ambienteConfig: "HOMOLOGACAO", ambienteRascunho: "PRODUCAO" })).toBe("PRODUCAO");
    expect(resolverAmbienteEmissao({ ambienteConfig: "PRODUCAO", ambienteRascunho: null })).toBe("PRODUCAO");
  });

  it("nenhum sinal reconhecido ⇒ DESCONHECIDO (nunca HOMOLOGACAO por omissao)", () => {
    for (const config of SINAIS_DESCONHECIDOS)
      for (const rascunho of SINAIS_DESCONHECIDOS) {
        const r = resolverAmbienteEmissao({ ambienteConfig: config, ambienteRascunho: rascunho });
        expect(r, JSON.stringify({ config, rascunho })).toBe("DESCONHECIDO");
      }
  });

  it("config ainda nao lida: rascunho HOMOLOGACAO nao pinta a tela de teste", () => {
    // O GET da config esta no ar. Um rascunho marcado HOMOLOGACAO pode ser
    // justamente o rascunho velho — entao o aviso fica NEUTRO ate a config
    // chegar, em vez de piscar "sem valor fiscal" para quem emite de verdade.
    expect(
      resolverAmbienteEmissao({ ambienteRascunho: "HOMOLOGACAO", configResolvida: false }),
    ).toBe("DESCONHECIDO");
    // Escalar, porem, vale na hora: rascunho em producao ja basta.
    expect(
      resolverAmbienteEmissao({ ambienteRascunho: "PRODUCAO", configResolvida: false }),
    ).toBe("PRODUCAO");
    // Config chegou (mesmo que tenha chegado vazia): o rascunho volta a valer.
    expect(
      resolverAmbienteEmissao({ ambienteRascunho: "HOMOLOGACAO", configResolvida: true }),
    ).toBe("HOMOLOGACAO");
    // Ausente = resolvido: quem nao usa a flag nao muda de comportamento.
    expect(resolverAmbienteEmissao({ ambienteRascunho: "HOMOLOGACAO" })).toBe("HOMOLOGACAO");
    // Config ja respondida nao e afetada pela flag.
    expect(
      resolverAmbienteEmissao({ ambienteConfig: "HOMOLOGACAO", configResolvida: false }),
    ).toBe("HOMOLOGACAO");
  });

  it("ruido de um lado nao apaga o sinal do outro", () => {
    for (const ruido of SINAIS_DESCONHECIDOS) {
      expect(resolverAmbienteEmissao({ ambienteConfig: ruido, ambienteRascunho: "PRODUCAO" })).toBe("PRODUCAO");
      expect(resolverAmbienteEmissao({ ambienteConfig: "HOMOLOGACAO", ambienteRascunho: ruido })).toBe("HOMOLOGACAO");
    }
  });
});

describe("avisoEmissao: PRODUCAO", () => {
  const aviso = avisoEmissao({ ambienteConfig: "PRODUCAO" });

  it("diz que a nota vale, sem a palavra 'teste' e sem citar homologacao", () => {
    expect(aviso.ambiente).toBe("PRODUCAO");
    expect(aviso.valeDeVerdade).toBe(true);
    expect(aviso.tom).toBe("atencao");
    expect(aviso.titulo).toBe("Esta nota vale de verdade");
    expect(texto(aviso)).toContain("produção");
    expect(texto(aviso)).toContain("vale para o fisco");
    expect(texto(aviso)).not.toContain("teste");
    expect(texto(aviso)).not.toContain("homologa");
  });

  it("avisa que o numero e definitivo", () => {
    expect(texto(aviso)).toContain("número é definitivo");
    expect(texto(aviso)).toContain("cancelamento");
  });

  it("nao contem o texto FIXO antigo", () => {
    expect(aviso.linhas).not.toContain(TEXTO_FIXO_ANTIGO);
  });
});

describe("avisoEmissao: HOMOLOGACAO (o texto de hoje, que la esta certo)", () => {
  const aviso = avisoEmissao({ ambienteConfig: "HOMOLOGACAO" });

  it("mantem a frase que a tela sempre mostrou e diz que nao tem valor fiscal", () => {
    expect(aviso.ambiente).toBe("HOMOLOGACAO");
    expect(aviso.valeDeVerdade).toBe(false);
    expect(aviso.tom).toBe("info");
    expect(aviso.linhas).toContain(TEXTO_FIXO_ANTIGO);
    expect(texto(aviso)).toContain("sem valor fiscal");
    expect(texto(aviso)).toContain("teste");
  });
});

describe("avisoEmissao: ambiente desconhecido", () => {
  const aviso = avisoEmissao({});

  it("texto neutro, com o peso de producao — e sem afirmar homologacao", () => {
    expect(aviso.ambiente).toBe("DESCONHECIDO");
    expect(aviso.valeDeVerdade).toBe(true);
    expect(aviso.tom).toBe("atencao");
    expect(texto(aviso)).not.toContain("homologa");
    expect(texto(aviso)).not.toContain("teste");
    expect(texto(aviso)).toContain("trate como emissão real");
    expect(aviso.linhas).not.toContain(TEXTO_FIXO_ANTIGO);
  });
});

describe("avisoEmissao: DEVOLUCAO (o fluxo da DLS)", () => {
  it("em producao, diz que e nota de ENTRADA e que referencia a venda original", () => {
    const aviso = avisoEmissao({ ambienteConfig: "PRODUCAO", finalidade: "DEVOLUCAO" });
    expect(aviso.titulo).toBe("Esta devolução vale de verdade");
    expect(texto(aviso)).toContain("nota de entrada");
    expect(texto(aviso)).toContain("nota de venda original");
    expect(texto(aviso)).toContain("número é definitivo");
    expect(texto(aviso)).not.toContain("teste");
  });

  it("NAO promete devolver a peca ao estoque — a devolucao e so fiscal", () => {
    // A devolucao e "operacao exclusivamente fiscal. O estoque nao sera
    // alterado" (devolucao-editor.tsx, dois passos antes deste aviso) e nenhum
    // caminho de nfe-devolucao.usecase.ts mexe em estoque. Uma versao anterior
    // deste texto dizia que a nota "traz a peca de volta para o seu estoque":
    // ela emitiria a nota e esperaria a peca reaparecer na prateleira do Dexo.
    for (const sinais of [
      { ambienteConfig: "PRODUCAO" },
      { ambienteConfig: "HOMOLOGACAO" },
      {},
    ]) {
      const t = texto(avisoEmissao({ ...sinais, finalidade: "DEVOLUCAO" }));
      const rotulo = JSON.stringify(sinais);
      expect(t, rotulo).not.toContain("de volta para o seu estoque");
      expect(t, rotulo).not.toContain("volta para o estoque");
    }
    // E, em producao, diz com todas as letras que o estoque nao muda.
    expect(texto(avisoEmissao({ ambienteConfig: "PRODUCAO", finalidade: "DEVOLUCAO" })))
      .toContain("o estoque do dexo não muda");
  });

  it("a linha da devolucao aparece nos tres ambientes", () => {
    for (const sinais of [
      { ambienteConfig: "PRODUCAO" },
      { ambienteConfig: "HOMOLOGACAO" },
      {},
    ]) {
      const comDev = avisoEmissao({ ...sinais, finalidade: "DEVOLUCAO" });
      const semDev = avisoEmissao({ ...sinais, finalidade: "NORMAL" });
      expect(texto(comDev), JSON.stringify(sinais)).toContain("nota de venda original");
      expect(texto(semDev), JSON.stringify(sinais)).not.toContain("nota de venda original");
      expect(comDev.linhas.length).toBe(semDev.linhas.length + 1);
    }
  });

  it("finalidade que nao e devolucao nao ganha a linha extra", () => {
    for (const f of ["NORMAL", "COMPLEMENTAR", "AJUSTE", undefined, null, ""])
      expect(ehDevolucao(f), String(f)).toBe(false);
    expect(ehDevolucao("DEVOLUCAO")).toBe(true);
    expect(ehDevolucao(" devolucao ")).toBe(true);
  });
});

describe("avisoEmissao: devolucao de COMPRA e nota de SAIDA (o caso da DLS)", () => {
  // As duas devolucoes sao OPOSTAS: a de VENDA e nota de ENTRADA (tpNF=0) e
  // referencia a nota que o desmanche emitiu; a de COMPRA e nota de SAIDA
  // (tpNF=1) e referencia a nota do FORNECEDOR. E a regra do servidor
  // (`validacao.ts`, TIPO_OPERACAO_INCOERENTE) e o que o `devolucao-editor.tsx`
  // ja escreve dois passos antes ("Devolucao de compra (saida)").
  //
  // A DLS devolvia uma COMPRA para a DISAUTO. O aviso chamava a nota dela de
  // "nota de ENTRADA" que "referencia a nota de venda original" — errado duas
  // vezes, na ULTIMA tela antes do clique, e contradizendo a propria tela.
  const comTipo = (tipoOperacao?: string | null, ambienteConfig = "PRODUCAO") =>
    avisoEmissao({ ambienteConfig, finalidade: "DEVOLUCAO", tipoOperacao });

  it("em producao, diz SAIDA e cita a nota do fornecedor", () => {
    const t = texto(comTipo("SAIDA"));
    expect(t).toContain("nota de saída");
    expect(t).toContain("nota do fornecedor");
    expect(t).not.toContain("nota de entrada");
    expect(t).not.toContain("nota de venda original");
    // O resto do bloco nao muda: segue so fiscal e com numero definitivo.
    expect(t).toContain("o estoque do dexo não muda");
    expect(t).toContain("número é definitivo");
  });

  it("SAIDA nunca vira ENTRADA em nenhum dos tres ambientes", () => {
    for (const ambiente of ["PRODUCAO", "HOMOLOGACAO", ""]) {
      const t = texto(comTipo("SAIDA", ambiente));
      expect(t, ambiente).toContain("nota de saída");
      expect(t, ambiente).not.toContain("nota de entrada");
      expect(t, ambiente).not.toContain("nota de venda original");
    }
  });

  it("ENTRADA mantem o texto da devolucao de venda, letra por letra", () => {
    expect(comTipo("ENTRADA").linhas).toEqual(comTipo(undefined).linhas);
    expect(texto(comTipo("ENTRADA"))).toContain("nota de entrada");
  });

  it("so 'SAIDA' conta como sinal; lixo nao inventa texto novo", () => {
    // `tipoOperacao` e campo obrigatorio do formulario, entao o caso sem sinal
    // nao existe na tela — e, nao existindo, mantem o texto de hoje.
    for (const v of [undefined, null, "", "   ", "ENTRADA", "entrada", "0", "saida-x"])
      expect(texto(comTipo(v)), String(v)).toContain("nota de entrada");
    // Caixa e espaco nao sao sinal novo, como no resto do modulo.
    expect(texto(comTipo(" saida "))).toContain("nota de saída");
  });

  it("fora da devolucao, tipoOperacao nao muda uma linha", () => {
    for (const finalidade of ["NORMAL", "COMPLEMENTAR", "AJUSTE"]) {
      const comSaida = avisoEmissao({ ambienteConfig: "PRODUCAO", finalidade, tipoOperacao: "SAIDA" });
      const semTipo = avisoEmissao({ ambienteConfig: "PRODUCAO", finalidade });
      expect(comSaida.linhas, finalidade).toEqual(semTipo.linhas);
    }
  });

  it("a linha da devolucao continua sendo UMA so, nos dois sentidos", () => {
    for (const tipoOperacao of ["ENTRADA", "SAIDA"]) {
      const comDev = avisoEmissao({ ambienteConfig: "PRODUCAO", finalidade: "DEVOLUCAO", tipoOperacao });
      const semDev = avisoEmissao({ ambienteConfig: "PRODUCAO", finalidade: "NORMAL", tipoOperacao });
      expect(comDev.linhas.length, tipoOperacao).toBe(semDev.linhas.length + 1);
    }
  });
});

describe("invariante: a tela so fala em homologacao/teste quando o dado diz homologacao", () => {
  const SINAIS = ["PRODUCAO", "HOMOLOGACAO", undefined, null, "", "sandbox"];
  const FINALIDADES = ["NORMAL", "DEVOLUCAO", "COMPLEMENTAR", undefined];

  it("varre a matriz inteira de sinais x finalidade", () => {
    let casos = 0;
    for (const ambienteConfig of SINAIS)
      for (const ambienteRascunho of SINAIS)
        for (const finalidade of FINALIDADES) {
          const aviso = avisoEmissao({ ambienteConfig, ambienteRascunho, finalidade });
          const t = texto(aviso);
          const rotulo = JSON.stringify({ ambienteConfig, ambienteRascunho, finalidade });

          if (aviso.ambiente === "HOMOLOGACAO") {
            // Unico ramo autorizado a dizer "homologacao"/"teste".
            expect(aviso.valeDeVerdade, rotulo).toBe(false);
            expect(t, rotulo).toContain("homologa");
          } else {
            // Producao e duvida: nem "homologa", nem "teste", nem o texto fixo.
            expect(t, rotulo).not.toContain("homologa");
            expect(t, rotulo).not.toContain("teste");
            expect(aviso.linhas, rotulo).not.toContain(TEXTO_FIXO_ANTIGO);
            expect(aviso.valeDeVerdade, rotulo).toBe(true);
            expect(aviso.tom, rotulo).toBe("atencao");
          }
          // Nunca sai vazio: o bloco existe em todos os casos.
          expect(aviso.titulo.length, rotulo).toBeGreaterThan(0);
          expect(aviso.linhas.length, rotulo).toBeGreaterThanOrEqual(2);
          casos++;
        }
    expect(casos).toBe(SINAIS.length * SINAIS.length * FINALIDADES.length);
  });
});
