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
//
// Validado contra a API real (Jotabê, 2026-06-29). O comentário ao lado de cada
// entrada é o `path` da categoria, para auditoria.
export const MAGALU_CATEGORY_MAP: Record<string, string> = {
  farol: "298cf208-e58e-4783-80e5-c907c01f7e0d", // Veículos e Peças/Luzes Veiculares/Farol para Veículos
  lanterna: "e1c2e4f9-0db4-431f-b9d2-f5bce0e6eb19", // Veículos e Peças/Luzes Veiculares/Lanterna para Veículos
  retrovisor: "7fd0ed06-3522-451d-b00c-c9452b5d116d", // Veículos e Peças/Carroceria e Acabamento/Retrovisor
  radiador: "bf433bbf-b01e-4d73-9633-38bc5de6222d", // Veículos e Peças/Suspensão e Direção/Radiador
  alternador: "34baa2da-6434-4d1e-b35e-6d448a196ea9", // Veículos e Peças/Elétrica e Ignição/Alternador para Veículos
  // Variações de nome do produto p/ casar o prefixo (com/sem "de").
  "compressor ar condicionado": "d3eb14cc-b5c4-4bad-8e42-57a71e6423e4", // Veículos e Peças/Suspensão e Direção/Compressor de Ar-condicionado para Veículos
  "compressor de ar condicionado": "d3eb14cc-b5c4-4bad-8e42-57a71e6423e4",

  // PENDENTE (a Magalu usa outro nome — redescobrir com --find-category):
  //   "tampa reservatorio"  → 0 resultados (tentar "reservatorio de agua")
  //   "para-choque"         → tentar "para-choque" / "para choque"
  //   "capo"                → é "capô" (tentar "capo dianteiro"/explorar Carroceria)
  //   "motor de partida"    → só achou subpeças (tentar "motor de arranque"/"partida")
};
