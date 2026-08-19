// ─────────────────────────────────────────────────────────────────────────────
// TIPO DE PEÇA DO ANÚNCIO OLX (`params.parts_name_*`).
//
// Na OLX a `category` é o TIPO DE VEÍCULO (2101 carros, 2102 caminhões, 2103
// motos, 2104 barcos, 2105 ônibus) — cinco, e ponto. O tipo de PEÇA viaja num
// parâmetro separado, e até aqui ele era uma constante: toda peça de carro saía
// como "4" (Peças automotivas), toda peça de moto como "10", toda de barco
// como "11".
//
// ⚠️ A CONSTANTE ESTAVA CERTA PARA QUASE TUDO. Medido no catálogo real
// (399.890 peças, 19/08/2026): 98,4% são legitimamente "Peças automotivas" —
// maçaneta, farol, motor, freio, câmbio, lataria, tudo isso. A tabela da OLX não
// classifica por sistema mecânico como a do Google; é comercial e grossa. O
// ganho real é 1,64% (6.566 peças) que hoje se escondem no genérico: pneus,
// rodas, calotas, som e GPS têm entrada PRÓPRIA no filtro da OLX, e é lá que o
// comprador procura por elas.
//
// ⚠️ NÃO-REGRESSÃO: quando nenhuma palavra casa, o valor é EXATAMENTE o de hoje.
// O payload de 98,4% dos anúncios fica byte a byte idêntico. A mudança é sempre
// genérico → específico, nunca A → B.
//
// Tabelas oficiais: portal de integração da OLX, /anuncio/api/autoparts,
// conferidas em 19/08/2026 nas cinco subcategorias. Carros, caminhões e ônibus
// compartilham `parts_name_cars`; motos e barcos têm tabelas próprias, com
// opções que não existem nas outras (capacete, âncora, hélice…).
// ─────────────────────────────────────────────────────────────────────────────

/** `parts_name_cars` — usado por 2101 (carros), 2102 (caminhões) e 2105 (ônibus). */
export const OLX_PARTS_CARS = {
  PNEUS: "1",
  RODAS: "2",
  CALOTAS: "3",
  /** O default de hoje, e o correto para 98,4% do catálogo. */
  PECAS: "4",
  GPS: "5",
  SOM: "6",
  TUNING: "7",
  ACESSORIOS_INTERIOR: "8",
  ACESSORIOS_EXTERIOR: "9",
  OUTROS: "10",
} as const;

/** `parts_name_motos` — 2103. Tabela PRÓPRIA: tem capacete, roupa, bagageiro. */
export const OLX_PARTS_MOTOS = {
  PNEUS: "1",
  RODAS: "2",
  CALOTAS: "3",
  CAPACETES: "4",
  ACABAMENTO: "5",
  ROUPAS: "6",
  BAGAGEIROS: "7",
  SUPORTES: "8",
  ALARMES: "9",
  /** O default de hoje. */
  PECAS: "10",
  OUTROS: "11",
} as const;

/** `parts_name_boats` — 2104. Tabela PRÓPRIA, e sem um genérico "peças". */
export const OLX_PARTS_BOATS = {
  MOTORES: "1",
  INVERSORES: "2",
  BOMBAS: "3",
  ILUMINACAO: "4",
  ROTORES: "5",
  CABOS: "6",
  VELAS: "7",
  SONARES_GPS: "8",
  HELICES: "9",
  ANCORAS: "10",
  /** O default de hoje. Não existe "peças" nesta tabela — "Outros" é o honesto. */
  OUTROS: "11",
} as const;

/**
 * Palavra no nome da peça → valor de `parts_name_cars`.
 *
 * Só entram os termos que a OLX separa no filtro. Todo o resto — maçaneta,
 * farol, motor, freio, suspensão, lataria — É "Peças automotivas", então fica
 * FORA do mapa de propósito e cai no default.
 */
export const OLX_PART_MAP_CARS: Record<string, string> = {
  pneu: OLX_PARTS_CARS.PNEUS,
  pneus: OLX_PARTS_CARS.PNEUS,

  roda: OLX_PARTS_CARS.RODAS,
  rodas: OLX_PARTS_CARS.RODAS,
  "roda de liga": OLX_PARTS_CARS.RODAS,
  // ⚠️ Estes são PEÇAS, não rodas — e sem eles "Cubo de Roda" e "Rolamento de
  // Roda" iriam para o filtro de rodas, onde ninguém procura por eles. Chave
  // mais longa vence, então derrubam `roda`.
  "cubo de roda": OLX_PARTS_CARS.PECAS,
  "parafuso de roda": OLX_PARTS_CARS.PECAS,
  "caixa de roda": OLX_PARTS_CARS.PECAS,
  "arco de roda": OLX_PARTS_CARS.PECAS,
  rolamento: OLX_PARTS_CARS.PECAS,

  calota: OLX_PARTS_CARS.CALOTAS,
  calotas: OLX_PARTS_CARS.CALOTAS,

  gps: OLX_PARTS_CARS.GPS,
  navegador: OLX_PARTS_CARS.GPS,

  // `radio` com word-boundary NÃO casa "radiador" — é o mesmo mecanismo que
  // impede `moto` de casar "motor".
  radio: OLX_PARTS_CARS.SOM,
  "alto falante": OLX_PARTS_CARS.SOM,
  "auto falante": OLX_PARTS_CARS.SOM,
  altofalante: OLX_PARTS_CARS.SOM,
  multimidia: OLX_PARTS_CARS.SOM,
  "central multimidia": OLX_PARTS_CARS.SOM,
  "cd player": OLX_PARTS_CARS.SOM,
  "dvd player": OLX_PARTS_CARS.SOM,
  subwoofer: OLX_PARTS_CARS.SOM,
  "som automotivo": OLX_PARTS_CARS.SOM,

  tapete: OLX_PARTS_CARS.ACESSORIOS_INTERIOR,
  carpete: OLX_PARTS_CARS.ACESSORIOS_INTERIOR,
  "capa de banco": OLX_PARTS_CARS.ACESSORIOS_INTERIOR,
};

/** Palavra → `parts_name_motos`. A tabela de motos tem opções próprias. */
export const OLX_PART_MAP_MOTOS: Record<string, string> = {
  pneu: OLX_PARTS_MOTOS.PNEUS,
  roda: OLX_PARTS_MOTOS.RODAS,
  calota: OLX_PARTS_MOTOS.CALOTAS,
  capacete: OLX_PARTS_MOTOS.CAPACETES,
  bagageiro: OLX_PARTS_MOTOS.BAGAGEIROS,
  bau: OLX_PARTS_MOTOS.BAGAGEIROS,
  alarme: OLX_PARTS_MOTOS.ALARMES,
  "cubo de roda": OLX_PARTS_MOTOS.PECAS,
  rolamento: OLX_PARTS_MOTOS.PECAS,
};

/** Palavra → `parts_name_boats`. Sem genérico "peças": o default é "Outros". */
export const OLX_PART_MAP_BOATS: Record<string, string> = {
  motor: OLX_PARTS_BOATS.MOTORES,
  inversor: OLX_PARTS_BOATS.INVERSORES,
  bomba: OLX_PARTS_BOATS.BOMBAS,
  farol: OLX_PARTS_BOATS.ILUMINACAO,
  lanterna: OLX_PARTS_BOATS.ILUMINACAO,
  iluminacao: OLX_PARTS_BOATS.ILUMINACAO,
  rotor: OLX_PARTS_BOATS.ROTORES,
  cabo: OLX_PARTS_BOATS.CABOS,
  vela: OLX_PARTS_BOATS.VELAS,
  sonar: OLX_PARTS_BOATS.SONARES_GPS,
  gps: OLX_PARTS_BOATS.SONARES_GPS,
  helice: OLX_PARTS_BOATS.HELICES,
  ancora: OLX_PARTS_BOATS.ANCORAS,
};

/** Qual tabela e qual default valem para cada categoria de veículo. */
export function tabelaDePecaDaCategoria(categoryId: number): {
  chave: string;
  mapa: Record<string, string>;
  padrao: string;
} | null {
  switch (categoryId) {
    case 2103:
      return {
        chave: "parts_name_motos",
        mapa: OLX_PART_MAP_MOTOS,
        padrao: OLX_PARTS_MOTOS.PECAS,
      };
    case 2104:
      return {
        chave: "parts_name_boats",
        mapa: OLX_PART_MAP_BOATS,
        padrao: OLX_PARTS_BOATS.OUTROS,
      };
    case 2101:
    case 2102:
    case 2105:
      return {
        chave: "parts_name_cars",
        mapa: OLX_PART_MAP_CARS,
        padrao: OLX_PARTS_CARS.PECAS,
      };
    default:
      // Categoria não-autopeça conhecida: sem `parts_name`. A OLX recusa o
      // anúncio se o parâmetro for enviado vazio ou 0, então é omitir mesmo.
      return null;
  }
}

/** Nome legível do tipo de peça, para a tela poder mostrar o que foi detectado. */
export const OLX_PART_LABEL: Record<string, Record<string, string>> = {
  parts_name_cars: {
    "1": "Pneus",
    "2": "Rodas",
    "3": "Calotas",
    "4": "Peças automotivas",
    "5": "GPS",
    "6": "Som e multimídia",
    "7": "Tuning e Performance",
    "8": "Acessórios para interior",
    "9": "Acessórios para exterior",
    "10": "Outros",
  },
  parts_name_motos: {
    "1": "Pneus",
    "2": "Rodas",
    "3": "Calotas",
    "4": "Capacetes",
    "5": "Acabamento",
    "6": "Roupas de moto",
    "7": "Bagageiros, baús e mochilas",
    "8": "Suportes",
    "9": "Alarmes",
    "10": "Peças de motos",
    "11": "Outros",
  },
  parts_name_boats: {
    "1": "Motores",
    "2": "Inversores",
    "3": "Bombas",
    "4": "Iluminação",
    "5": "Rotores",
    "6": "Cabos",
    "7": "Velas",
    "8": "Sonares e GPS",
    "9": "Hélices",
    "10": "Âncoras",
    "11": "Outros",
  },
};
