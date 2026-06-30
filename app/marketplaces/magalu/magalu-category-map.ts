// De-para CURADO: tipo de peça → id da categoria Magalu.
//
// Por quê: a busca por nome (/categories?name=) acerta o DOMÍNIO ("Veículos e
// Peças") mas erra o LEAF para autopeças usadas (taxonomia genérica + similaridade
// que aproxima peças diferentes — ex.: "tampa de reservatório" cai em "Junta da
// Tampa de Válvula"). O mapa é consultado ANTES da busca: casamento por PREFIXO
// mais longo do nome do produto (normalizado: minúsculas, sem acento).
//
// Como popular (descobrir o id certo de um tipo):
//   npx tsx scripts/test-magalu-create-listing.ts --user-id=... --find-category="tampa reservatorio"
//   → lista os candidatos; pegue o id da linha marcada com ★ (path em Veículos e
//     Peças) que melhor descreve a peça e adicione abaixo.
//
// Escopo: v1 GLOBAL (a Jotabê é o único seller Magalu hoje). Se entrar outro
// seller com taxonomia própria, migrar para um mapa por conta (DB).
export const MAGALU_CATEGORY_MAP: Record<string, string> = {
  // "tampa reservatorio": "<categoryId>",
  // "farol": "<categoryId>",
  // "lanterna": "<categoryId>",
  // "parachoque": "<categoryId>",
  // "retrovisor": "<categoryId>",
};
