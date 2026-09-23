import { describe, expect, it } from "vitest";

import {
  decidirReligamento,
  LIMIARES,
  type Anuncio,
  type Candidato,
  type Contexto,
} from "../scripts/catalog-dedupe/lib/veredito-religamento";

const anuncio: Anuncio = {
  externo: "MLB5138890007",
  titulo: "Acabamento Lateral Console Central Fiat Stilo 2003",
  sku: "7838",
  statusNoMl: "active",
  quantidadeNoMl: 1,
  contaId: "conta-1",
  tenantDaConta: "tenant-1",
};

const candidato: Candidato = {
  id: "prod-certo",
  nome: "Acabamento Lateral Console Central Fiat Stilo 2003",
  sku: "7838",
  tenantDoProduto: "tenant-1",
  disponivel: 1,
  fotosEmComum: 4,
  usoDoSku: 1,
  usoDaFoto: 2,
  temAnuncioVivoNaConta: false,
  anuncioTemOverride: false,
  recebivelPendente: false,
};

const contexto: Contexto = {
  notaDoCampeao: 1,
  notaDoSegundo: 0.4,
  notaDoAtual: 0,
  canalApontaOutroProduto: false,
};

const com = <T,>(base: T, mudanca: Partial<T>): T => ({ ...base, ...mudanca });

describe("o caso limpo", () => {
  it("religa quando titulo alto, duas testemunhas e nenhuma guarda acusa", () => {
    const d = decidirReligamento(anuncio, candidato, contexto);
    expect(d.veredito).toBe("RELIGAR");
    expect(d.motivos).toEqual([]);
    expect(d.testemunhas).toEqual(["sku", "foto"]);
  });
});

describe("o anuncio precisa estar no ar", () => {
  it("nao se aplica a anuncio pausado", () => {
    expect(decidirReligamento(com(anuncio, { statusNoMl: "paused" }), candidato, contexto).veredito)
      .toBe("NAO_APLICAVEL");
  });

  it("nao se aplica a anuncio com quantidade zero", () => {
    expect(decidirReligamento(com(anuncio, { quantidadeNoMl: 0 }), candidato, contexto).veredito)
      .toBe("NAO_APLICAVEL");
  });
});

describe("duas testemunhas independentes", () => {
  it("recusa quando so o titulo concorda", () => {
    const semProva = com(candidato, { sku: "outro", fotosEmComum: 0 });
    const d = decidirReligamento(anuncio, semProva, contexto);
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("nenhum canal independente");
  });

  it("anula o SKU que se repete no catalogo, porque e rotulo de caixa", () => {
    // Um cliente tem UM produto de SKU "1" e 7.328 anuncios carregando "1".
    const rotulo = com(candidato, { usoDoSku: LIMIARES.maxUsoDoSku + 1, fotosEmComum: 0 });
    const d = decidirReligamento(anuncio, rotulo, contexto);
    expect(d.testemunhas).not.toContain("sku");
    expect(d.veredito).toBe("REVISAR");
  });

  it("anula a foto generica, usada por muitos produtos", () => {
    const generica = com(candidato, { sku: "outro", usoDaFoto: LIMIARES.maxUsoDaFoto + 1 });
    expect(decidirReligamento(anuncio, generica, contexto).testemunhas).not.toContain("foto");
  });

  it("exige DUAS fotos em comum: uma so e coincidencia", () => {
    const umaFoto = com(candidato, { sku: "outro", fotosEmComum: 1 });
    expect(decidirReligamento(anuncio, umaFoto, contexto).testemunhas).not.toContain("foto");
  });

  it("aceita a foto sozinha como segunda testemunha quando o titulo e alto", () => {
    const soFoto = com(candidato, { sku: null });
    const d = decidirReligamento(com(anuncio, { sku: null }), soFoto, contexto);
    expect(d.testemunhas).toEqual(["foto"]);
    expect(d.veredito).toBe("RELIGAR");
  });
});

describe("as guardas que impedem trocar um defeito por outro", () => {
  it("chama de EMPILHADO quando a peca certa ja tem anuncio vivo na conta", () => {
    // Nao existe unicidade (produto, conta) e o sync empurra o estoque CHEIO do
    // produto para cada anuncio dele: religar aqui vira venda dupla.
    const d = decidirReligamento(anuncio, com(candidato, { temAnuncioVivoNaConta: true }), contexto);
    expect(d.veredito).toBe("EMPILHADO");
  });

  it("chama de CONFLITO quando canais independentes discordam", () => {
    const d = decidirReligamento(anuncio, candidato, com(contexto, { canalApontaOutroProduto: true }));
    expect(d.veredito).toBe("CONFLITO");
  });

  it("veta lado oposto mesmo com foto e SKU concordando", () => {
    // O desmanche fotografa a peca esquerda e usa a MESMA foto no anuncio da
    // direita: foto compartilhada prova "mesma familia", nunca "mesmo lado".
    const esquerda = com(anuncio, { titulo: "Amortecedor Tampa Porta Malas L/e Gol 2021" });
    const direita = com(candidato, { nome: "Amortecedor Tampa Porta Malas L/d Gol 2021" });
    const d = decidirReligamento(esquerda, direita, contexto);
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("lado ou eixo");
  });

  it("veta eixo oposto", () => {
    const d = decidirReligamento(
      com(anuncio, { titulo: "Parabarro Dianteiro Direito Argo 2019" }),
      com(candidato, { nome: "Parabarro Traseiro Direito Argo 2019" }),
      contexto,
    );
    expect(d.veredito).toBe("REVISAR");
  });

  it("recusa peca de outro cliente, que o banco aceitaria calado", () => {
    const d = decidirReligamento(anuncio, com(candidato, { tenantDoProduto: "tenant-2" }), contexto);
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("outro cliente");
  });

  it("recusa anuncio com override, que continuaria publicando a peca antiga", () => {
    const d = decidirReligamento(anuncio, com(candidato, { anuncioTemOverride: true }), contexto);
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("override");
  });

  it("recusa destino sem saldo, que sairia do ar em 24 h", () => {
    const d = decidirReligamento(anuncio, com(candidato, { disponivel: 0 }), contexto);
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("sem saldo");
  });

  it("recusa destino com venda de balcao em aberto", () => {
    const d = decidirReligamento(anuncio, com(candidato, { recebivelPendente: true }), contexto);
    expect(d.veredito).toBe("REVISAR");
  });
});

describe("as margens", () => {
  it("recusa titulo abaixo do limiar", () => {
    const d = decidirReligamento(anuncio, candidato, com(contexto, { notaDoCampeao: LIMIARES.minTitulo - 0.01 }));
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("abaixo de");
  });

  it("recusa empate com o segundo colocado", () => {
    const d = decidirReligamento(anuncio, candidato, com(contexto, { notaDoSegundo: 0.95 }));
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("empate");
  });

  it("aceita quando nao existe segundo colocado", () => {
    expect(decidirReligamento(anuncio, candidato, com(contexto, { notaDoSegundo: null })).veredito)
      .toBe("RELIGAR");
  });

  it("recusa quando o candidato nao ganha do vinculo atual com folga", () => {
    // Sem esta margem o script troca um vinculo mediano por outro mediano e so
    // embaralha.
    const d = decidirReligamento(anuncio, candidato, com(contexto, { notaDoAtual: 0.9 }));
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("claramente melhor");
  });
});

describe("sem candidato", () => {
  it("manda para revisao humana em vez de inventar destino", () => {
    const d = decidirReligamento(anuncio, null, contexto);
    expect(d.veredito).toBe("REVISAR");
    expect(d.motivos.join(" ")).toContain("nenhuma peca do catalogo");
  });
});
