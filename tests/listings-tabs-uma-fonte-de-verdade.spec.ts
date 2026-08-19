import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * A CORRIDA QUE A PAGINAÇÃO INTRODUZIU.
 *
 * A primeira versão desta paginação zerava a página num `useEffect` disparado
 * por `selectedAccountId`, e `page` estava nas dependências do `fetchListings`.
 * Os dois viajavam em commits DIFERENTES, então trocar de conta estando na
 * página 3 disparava DUAS buscas: uma com a página velha e outra com a nova.
 *
 * Sem guarda de resposta obsoleta, quem mandava era a ordem de CHEGADA. Se a
 * busca da página 3 chegasse por último numa conta pequena, ela escrevia lista
 * vazia por cima do resultado certo — e a recuperação não acontecia, porque o
 * `setPage(1)` do salva-vidas era no-op (o estado já era 1). Resultado para o
 * operador: "Nenhum anúncio encontrado" numa conta que tem anúncios.
 *
 * E havia uma segunda fonte de verdade: o rodapé lia `pagination.page` (eco do
 * servidor) enquanto os botões escreviam em `page` (estado local). Divergindo os
 * dois, "Anterior" virava botão morto.
 *
 * As três correções:
 *   1. a página zera NO EVENTO da troca de conta — uma busca, não duas;
 *   2. bilhete de requisição descarta resposta que chega fora de ordem;
 *   3. o rodapé lê `page`, o estado local — uma fonte de verdade só.
 *
 * ⚠️ HONESTIDADE SOBRE O QUE ESTE ARQUIVO PROVA: a suíte não tem jsdom nem
 * @testing-library/react (decisão registrada em
 * tests/product-draft-reads-on-open.spec.ts), então não há como montar o
 * componente e observar a corrida. O que se trava aqui é o TEXTO-FONTE das cinco
 * abas. Isso prova que a estrutura correta está presente — não que o React se
 * comporta como esperado. Serve porque os três defeitos eram estruturais, e
 * porque a regressão mais provável é alguém reintroduzir o padrão antigo numa
 * aba só, quebrando a simetria entre os cinco canais.
 */

const ABAS: Array<[string, string]> = [
  ["mercado-livre", "ml"],
  ["shopee", "shopee"],
  ["magalu", "magalu"],
  ["olx", "olx"],
  ["facebook", "facebook"],
];

const fonte = (pasta: string, canal: string) =>
  fs.readFileSync(
    path.resolve(
      __dirname,
      "..",
      "app",
      "integracoes",
      pasta,
      "components",
      `${canal}-listings-tab.tsx`,
    ),
    "utf8",
  );

describe("abas de Anúncios — uma fonte de verdade para a página", () => {
  it("o rodapé é alimentado pelo estado local, nunca pelo eco do servidor", () => {
    for (const [pasta, canal] of ABAS) {
      const src = fonte(pasta, canal);
      expect(src, canal).toContain("page={page}");
      // `pagination.page` no JSX é a segunda fonte de verdade que matava o botão
      // "Anterior" quando divergia do estado local.
      expect(src, `${canal}: rodapé lendo pagination.page`).not.toContain(
        "page={pagination.page}",
      );
      // O total e o número de páginas SEGUEM vindo do servidor — é ele que sabe.
      expect(src, canal).toContain("total={pagination.total}");
      expect(src, canal).toContain("totalPages={pagination.totalPages}");
    }
  });

  it("trocar de conta zera a página no MESMO evento — uma busca, não duas", () => {
    for (const [pasta, canal] of ABAS) {
      const src = fonte(pasta, canal);
      expect(src, canal).toContain("setSelectedAccountId(e.target.value);");
      expect(src, canal).toContain("setPage(1);");
      // O efeito separado era a causa da corrida: ele agendava o reset num
      // commit e o fetch saía no anterior, com a página velha.
      expect(
        src.replace(/\s+/g, " "),
        `${canal}: voltou o useEffect de reset por conta`,
      ).not.toContain("useEffect(() => { setPage(1); }, [selectedAccountId]);");
    }
  });

  it("toda saída do fetch passa pelo bilhete de requisição", () => {
    for (const [pasta, canal] of ABAS) {
      const src = fonte(pasta, canal);

      expect(src, `${canal}: sem contador`).toContain(
        "const requisicaoEmCurso = useRef(0);",
      );
      expect(src, `${canal}: não emite bilhete`).toContain(
        "const bilhete = ++requisicaoEmCurso.current;",
      );

      // Os quatro pontos onde uma resposta obsoleta poderia escrever na tela:
      // sucesso, 404, erro e o desligamento do "carregando".
      const guardas = src.match(/bilhete\s*[!=]==\s*requisicaoEmCurso\.current/g);
      expect(
        guardas?.length ?? 0,
        `${canal}: guardas de obsolescência`,
      ).toBeGreaterThanOrEqual(4);
    }
  });

  it("o salva-vidas de página além do fim continua lá", () => {
    // Apagar anúncios por outro caminho deixava o operador numa página que não
    // existe mais, com os botões travados e sem forma de voltar.
    for (const [pasta, canal] of ABAS) {
      const src = fonte(pasta, canal).replace(/\s+/g, " ");
      expect(src, canal).toContain(
        "if (data.listings.length === 0 && page > 1) { setPage(1); }",
      );
    }
  });

  it("os cinco canais receberam o MESMO tratamento", () => {
    // Divergência entre irmãos foi a origem da maioria dos defeitos deste
    // trabalho. Aqui a simetria é verificável: mesmas peças, mesma contagem.
    const assinaturas = ABAS.map(([pasta, canal]) => {
      const src = fonte(pasta, canal);
      return [
        canal,
        (src.match(/requisicaoEmCurso/g) ?? []).length,
        (src.match(/setPage\(/g) ?? []).length,
        (src.match(/LISTINGS_POR_PAGINA/g) ?? []).length,
        (src.match(/<ListingsPagination/g) ?? []).length,
      ] as const;
    });

    const [, ...referencia] = assinaturas[0];
    for (const [canal, ...contagem] of assinaturas) {
      expect(contagem, `${canal} destoa dos irmãos`).toEqual([...referencia]);
    }
  });
});
