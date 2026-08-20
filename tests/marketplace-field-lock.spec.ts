import { describe, expect, it } from "vitest";

import {
  SLUG_CANAL,
  TEXTO_CAMPO,
  oemTravadoNoProduto,
  precisaTravar,
  type CampoTravado,
} from "../app/produtos/lib/marketplace-field-lock";

/**
 * A trava existe porque o Mercado Livre congela três coisas quando o anúncio
 * vai ao ar — a categoria, o `PART_NUMBER` e o `OEM` — e o modal, até então,
 * oferecia os três como se fossem editáveis. Quem alterava via "salvo com
 * sucesso" e concluía, com razão, que o anúncio tinha mudado.
 *
 * O que estes testes protegem não é o desenho: é a DECISÃO de travar, que tem
 * um caso de borda invisível (a lista de anúncios ainda carregando) e uma
 * assimetria que já rendeu um bug — o código de peça é cobrado em dois campos
 * da tela, e travar um sem o outro é pior do que não travar nenhum.
 */

describe("precisaTravar", () => {
  const base = { carregando: false, anunciosPublicados: 0, liberado: false };

  it("produto ainda não anunciado fica livre — não há o que confundir", () => {
    expect(precisaTravar(base)).toBe(false);
  });

  it("um anúncio publicado já basta para travar", () => {
    expect(precisaTravar({ ...base, anunciosPublicados: 1 })).toBe(true);
  });

  it("trava enquanto a lista de anúncios não respondeu", () => {
    // A contagem ainda é 0 e MENTE: a resposta não chegou. Liberar aqui
    // deixaria uma janela em que o campo parece editável e não é — que é
    // exatamente a impressão que a trava existe para desfazer.
    expect(precisaTravar({ ...base, carregando: true })).toBe(true);
  });

  it("a confirmação do operador vence a contagem", () => {
    expect(
      precisaTravar({ ...base, anunciosPublicados: 4, liberado: true }),
    ).toBe(false);
  });

  it("a confirmação do operador vence até o carregamento", () => {
    expect(precisaTravar({ ...base, carregando: true, liberado: true })).toBe(
      false,
    );
  });

  it("contagem 0 com a lista resolvida não trava — o inverso travaria todo produto novo", () => {
    expect(
      precisaTravar({
        carregando: false,
        anunciosPublicados: 0,
        liberado: false,
      }),
    ).toBe(false);
  });
});

describe("oemTravadoNoProduto", () => {
  const produto = {
    emModoAnuncio: false,
    liberado: false,
    carregando: false,
    anunciosPublicadosMl: 0,
  };

  it("no modo produto, anúncio publicado no ML trava o Código OEM", () => {
    expect(oemTravadoNoProduto({ ...produto, anunciosPublicadosMl: 2 })).toBe(
      true,
    );
  });

  it("no modo produto, produto sem anúncio no ML deixa o OEM livre", () => {
    expect(oemTravadoNoProduto(produto)).toBe(false);
  });

  it("no modo produto, trava enquanto a lista carrega", () => {
    expect(oemTravadoNoProduto({ ...produto, carregando: true })).toBe(true);
  });

  it("no modo produto, a confirmação no Part Number destrava o OEM", () => {
    expect(
      oemTravadoNoProduto({
        ...produto,
        anunciosPublicadosMl: 3,
        liberado: true,
      }),
    ).toBe(false);
  });

  it("editando anúncio de OUTRO canal, o OEM NÃO trava mesmo com anúncio no ML", () => {
    // O bug que esta função existe para impedir: Shopee, OLX e Facebook
    // aceitam o código na edição (reconstroem a ficha ou o anúncio inteiro).
    // Travar ali usando a contagem do Mercado Livre seria mentira — e pior,
    // deixaria o "Part Number" editável logo acima de um "Código OEM" travado.
    expect(
      oemTravadoNoProduto({
        ...produto,
        emModoAnuncio: true,
        anunciosPublicadosMl: 5,
      }),
    ).toBe(false);
  });

  it("editando anúncio, nem o carregamento trava", () => {
    expect(
      oemTravadoNoProduto({
        ...produto,
        emModoAnuncio: true,
        carregando: true,
      }),
    ).toBe(false);
  });

  it("fora do modo anúncio decide EXATAMENTE como o Part Number decide", () => {
    // Os dois campos são governados por uma trava só. Se as duas decisões
    // divergirem em qualquer combinação, o operador vê um campo aberto e o
    // outro fechado para o mesmo dado — o sintoma que motivou a unificação.
    for (const carregando of [false, true]) {
      for (const liberado of [false, true]) {
        for (const anunciosPublicados of [0, 1, 7]) {
          expect(
            oemTravadoNoProduto({
              emModoAnuncio: false,
              liberado,
              carregando,
              anunciosPublicadosMl: anunciosPublicados,
            }),
          ).toBe(precisaTravar({ carregando, anunciosPublicados, liberado }));
        }
      }
    }
  });
});

describe("textos por campo", () => {
  const campos: CampoTravado[] = ["categoria", "codigo"];

  it("os dois campos têm texto e nenhuma frase é vazia", () => {
    expect(Object.keys(TEXTO_CAMPO).sort()).toEqual([...campos].sort());
    for (const campo of campos) {
      const t = TEXTO_CAMPO[campo];
      expect(t.naoAceita.trim().length).toBeGreaterThan(0);
      expect(t.continuam.trim().length).toBeGreaterThan(0);
      expect(t.personalizacao.trim().length).toBeGreaterThan(0);
    }
  });

  it("categoria e código não compartilham nenhuma frase", () => {
    // Se compartilhassem, a prop `campo` estaria decorativa e o aviso do
    // código de peça falaria de categoria — que é o texto errado na tela.
    expect(TEXTO_CAMPO.categoria.naoAceita).not.toBe(
      TEXTO_CAMPO.codigo.naoAceita,
    );
    expect(TEXTO_CAMPO.categoria.continuam).not.toBe(
      TEXTO_CAMPO.codigo.continuam,
    );
    expect(TEXTO_CAMPO.categoria.personalizacao).not.toBe(
      TEXTO_CAMPO.codigo.personalizacao,
    );
  });

  it("cada frase encaixa no meio da sentença que a exibe", () => {
    // `naoAceita` entra em "O {canal} não aceita ___." e `continuam` em
    // "os N anúncios ___" — as duas emendam texto. Começar com maiúscula ou
    // terminar em ponto quebraria a frase na tela.
    for (const campo of campos) {
      const t = TEXTO_CAMPO[campo];
      for (const frase of [t.naoAceita, t.continuam]) {
        expect(frase[0]).toBe(frase[0].toLowerCase());
        expect(frase.endsWith(".")).toBe(false);
      }
    }
  });

  it("o texto do código fala de código, e o da categoria fala de categoria", () => {
    expect(TEXTO_CAMPO.codigo.naoAceita).toContain("código");
    expect(TEXTO_CAMPO.categoria.naoAceita).toContain("categoria");
  });
});

describe("slug do canal", () => {
  it("vira identificador estável, sem espaço nem maiúscula", () => {
    for (const slug of Object.values(SLUG_CANAL)) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("cada canal tem o seu — dois canais com o mesmo slug colidiriam no testid", () => {
    const slugs = Object.values(SLUG_CANAL);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
