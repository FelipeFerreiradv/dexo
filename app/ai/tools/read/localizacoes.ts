// Tool de leitura de LOCALIZAÇÕES.
//
// Embrulha `LocationUseCase.listForSelect` — a mesma função que alimenta o
// campo de localização no cadastro de produto. É a ÚNICA do domínio que produz
// `fullPath` ("Barracão 1 > R1 > T1 > A2") e `isFull`, que são exatamente o que
// o lojista quer ouvir.
//
// Ela não pagina (location.repository.ts:146-147, "não pagina" está lá em
// comentário) e devolve a árvore inteira do tenant. O filtro e o teto acontecem
// AQUI, em memória: a alternativa seria escrever uma query nova, e query nova é
// número novo — o oposto do critério desta fase.

import { z } from "zod";

import { LocationUseCase } from "../../../usecases/location.usercase";
import { normalizeTerm } from "../../../repositories/product-search-terms";
import type { AiTool } from "../registry";
import { num } from "../serialize";

const MAX_ITENS = 20;

export const buscarLocalizacao: AiTool = {
  name: "buscar_localizacao",
  description:
    "Lista ou busca localizações do estoque (prateleiras, gavetas, barracões) pelo código ou pela descrição. " +
    "Devolve o caminho completo na árvore, quantas peças estão guardadas ali e se está cheia. " +
    "Sem termo de busca, devolve as primeiras localizações da loja.",
  args: z
    .object({
      consulta: z
        .string()
        .max(80)
        .optional()
        .describe(
          "Código ou parte da descrição. Ex.: 'PRT-01', 'gaveta', 'barracao 2'.",
        ),
      somenteCheias: z
        .boolean()
        .optional()
        .describe(
          "true para trazer só as localizações que atingiram a capacidade.",
        ),
      limite: z.number().int().min(1).max(MAX_ITENS).optional(),
    })
    .strict(),
  kind: "read",
  page: "localizacoes",
  keywords: [
    "localiza",
    "prateleira",
    "gaveta",
    "barracao",
    "estante",
    "onde esta",
    "guardad",
    "endereco",
  ],
  sourceLabel: "Localizações do seu estoque",
  handler: async (args, scope) => {
    const limite = Math.min(args.limite ?? 10, MAX_ITENS);
    const usecase = new LocationUseCase();
    const todas = await usecase.listForSelect(scope.dataOwnerId);

    const termo = normalizeTerm(args.consulta ?? "");
    const filtradas = todas.filter((l: any) => {
      if (args.somenteCheias && !l.isFull) return false;
      if (!termo) return true;
      const alvo = normalizeTerm(
        `${l.code} ${l.description ?? ""} ${l.fullPath}`,
      );
      return alvo.includes(termo);
    });

    return {
      total: filtradas.length,
      exibidos: Math.min(filtradas.length, limite),
      observacao:
        filtradas.length > limite
          ? `Existem ${filtradas.length} localizações que casam; estas são as ${limite} primeiras.`
          : undefined,
      itens: filtradas.slice(0, limite).map((l: any) => ({
        id: l.id,
        codigo: l.code,
        caminho: l.fullPath,
        descricao: l.description ?? null,
        pecasGuardadas: num(l.productsCount),
        capacidade: num(l.maxCapacity),
        // `capacidade: 0` significa "sem limite" no cadastro — dizer isso evita
        // o modelo reportar "capacidade zero" como se fosse prateleira lotada.
        semLimiteDeCapacidade: (l.maxCapacity ?? 0) === 0,
        cheia: Boolean(l.isFull),
      })),
    };
  },
};
