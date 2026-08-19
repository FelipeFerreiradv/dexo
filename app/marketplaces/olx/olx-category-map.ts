// De-para de VEÍCULO → código INTEIRO de categoria OLX (autopeças).
//
// ⚠️ Correção vs. a 1ª versão (que assumia peça→código, modelo errado): na OLX a
// `category` de autopeças é escolhida pelo TIPO DE VEÍCULO (carro / caminhão /
// moto / barco / ônibus), NÃO pelo tipo de peça. O tipo de peça vai nos `params`
// (parts_name_*). Validado no portal developers.olx.com.br
// (/anuncio/api/autoparts, 2026-07-20).
//
// Subcategorias de Autopeças (códigos REAIS):
//   2101 Carros, vans e utilitários   2102 Caminhões   2103 Motos
//   2104 Barcos e aeronaves           2105 Ônibus
//
// Escopo: v1 GLOBAL (Jotabê é o único seller OLX hoje, majoritariamente peça de
// carro). Se entrar outro seller, migrar para mapa por conta (DB), como Magalu.
export const OLX_AUTOPARTS_CATEGORY = {
  CARS: 2101,
  TRUCKS: 2102,
  MOTORCYCLES: 2103,
  BOATS: 2104,
  BUSES: 2105,
} as const;

// De-para veículo → categoria. A resolução casa por PALAVRA (word-boundary) no
// nome do produto — a chave mais longa vence. `\bmoto\b` NÃO casa "motor" nem
// "suporte do motor". Sem match → OLX_DEFAULT_CATEGORY_ID (carros). O produto
// pode sobrescrever com `olxCategoryId` explícito (vence tudo).
export const OLX_CATEGORY_MAP: Record<string, number> = {
  // Motos (2103)
  moto: OLX_AUTOPARTS_CATEGORY.MOTORCYCLES,
  motos: OLX_AUTOPARTS_CATEGORY.MOTORCYCLES,
  motocicleta: OLX_AUTOPARTS_CATEGORY.MOTORCYCLES,
  motoneta: OLX_AUTOPARTS_CATEGORY.MOTORCYCLES,
  scooter: OLX_AUTOPARTS_CATEGORY.MOTORCYCLES,
  // Caminhões (2102)
  caminhao: OLX_AUTOPARTS_CATEGORY.TRUCKS,
  caminhoes: OLX_AUTOPARTS_CATEGORY.TRUCKS,
  carreta: OLX_AUTOPARTS_CATEGORY.TRUCKS,
  truck: OLX_AUTOPARTS_CATEGORY.TRUCKS,
  // Ônibus (2105) — "onibus" também casa "micro-ônibus" (word-boundary no hífen).
  onibus: OLX_AUTOPARTS_CATEGORY.BUSES,
  // Barcos e aeronaves (2104)
  barco: OLX_AUTOPARTS_CATEGORY.BOATS,
  lancha: OLX_AUTOPARTS_CATEGORY.BOATS,
  jetski: OLX_AUTOPARTS_CATEGORY.BOATS,
  aeronave: OLX_AUTOPARTS_CATEGORY.BOATS,
  aviao: OLX_AUTOPARTS_CATEGORY.BOATS,
};

// Default: Carros, vans e utilitários (2101). A Jotabê é majoritariamente
// autopeça de carro; sem match de veículo no nome, cai aqui (não em null) — o
// insert acontece com categoria válida.
export const OLX_DEFAULT_CATEGORY_ID: number | null =
  OLX_AUTOPARTS_CATEGORY.CARS;

/**
 * Nome de exibição de cada categoria — o que o operador lê na tela.
 *
 * ⚠️ NÃO confundir com as chaves de OLX_CATEGORY_MAP: aquelas são as PALAVRAS
 * que a resolução procura no nome do produto ("moto", "caminhao", "lancha") e
 * servem para casar, não para mostrar. Exibi-las levava a tela a dizer "moto"
 * — ou, quando a lista ainda não tinha sido carregada, o número cru "2103".
 *
 * São só cinco: na OLX, autopeça é classificada por TIPO DE VEÍCULO. Não há
 * árvore a navegar, então a tela mostra as cinco e pronto.
 */
export const OLX_CATEGORY_LABEL: Record<number, string> = {
  [OLX_AUTOPARTS_CATEGORY.CARS]: "Carros, vans e utilitários",
  [OLX_AUTOPARTS_CATEGORY.TRUCKS]: "Caminhões",
  [OLX_AUTOPARTS_CATEGORY.MOTORCYCLES]: "Motos",
  [OLX_AUTOPARTS_CATEGORY.BOATS]: "Barcos e aeronaves",
  [OLX_AUTOPARTS_CATEGORY.BUSES]: "Ônibus",
};
