// ─────────────────────────────────────────────────────────────────────────────
// DE-PARA DE TIPO DE PEÇA → cesta do catálogo Meta.
//
// A Meta classifica pela taxonomia de produtos do Google, que é publicada e tem
// versão em PORTUGUÊS oficial com os MESMOS ids do inglês
// (google.com/basepages/producttype/taxonomy-with-ids.pt-BR.txt, 5.596 linhas).
// Sob "Peças para veículos motorizados" (899) existem 21 cestas por SISTEMA —
// freios, suspensão, lataria, elétrica… A integração usava só 3 categorias, e
// toda peça caía na genérica.
//
// ⚠️ O VALOR CONTINUA SENDO O CAMINHO EM INGLÊS. É ele que a Meta recebe; o
// português é só o que aparece na tela. Traduzir o valor faz o item ser recusado
// com HTTP 200, sem ninguém ver.
//
// ⚠️ VEÍCULO ANTES DE PEÇA. "Farol de Moto" é peça de MOTO, não iluminação de
// carro. A resolução consulta primeiro o de-para de veículo
// (FACEBOOK_CATEGORY_MAP: moto/barco) e só depois este. Sem essa ordem, a regra
// de "chave mais longa vence" faria `farol`(5) ganhar de `moto`(4) e mudaria o
// destino de toda peça de moto — regressão silenciosa.
//
// ⚠️ NA DÚVIDA, NÃO MAPEIE. As palavras mais frequentes do catálogo real
// (medido em 19/08/2026) incluem `suporte` (18.522), `tampa` (9.847), `caixa`
// (6.297), `guia` (4.603), `par` (4.334), `kit` (2.867) — todas ambíguas
// sozinhas: suporte de quê? Fora do mapa, elas deixam a palavra ESPECÍFICA do
// nome decidir ("Suporte Superior Amortecedor" resolve por `amortecedor`), e
// quando não há nenhuma o item cai na cesta genérica — que é exatamente o que
// acontece hoje com 100% do catálogo. Este de-para só pode melhorar.
//
// Chaves compostas existem para desempatar: o casamento é por palavra inteira e
// a chave MAIS LONGA vence, então `maquina de vidro` ganha de `vidro`, e
// `coletor de escape` ganha de `coletor`.
// ─────────────────────────────────────────────────────────────────────────────

const P = "Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts";

/** As 21 cestas por sistema. O id do Google fica no comentário — é o que permite
 *  conferir contra a taxonomia oficial sem depender da minha tradução. */
export const FB_PART = {
  /** 8227 */ CARROCERIA: `${P} > Motor Vehicle Frame & Body Parts`,
  /** 3318 */ ILUMINACAO: `${P} > Motor Vehicle Lighting`,
  /** 2534 */ JANELAS: `${P} > Motor Vehicle Window Parts & Accessories`,
  /** 2642 */ ESPELHOS: `${P} > Motor Vehicle Mirrors`,
  /** 8238 */ BANCOS: `${P} > Motor Vehicle Seating`,
  /** 8233 */ INTERIOR: `${P} > Motor Vehicle Interior Fittings`,
  /** 8232 */ ESTOFADOS: `${P} > Motor Vehicle Carpet & Upholstery`,
  /** 8235 */ CONTROLES: `${P} > Motor Vehicle Controls`,
  /** 2977 */ FREIOS: `${P} > Motor Vehicle Braking`,
  /** 2935 */ SUSPENSAO: `${P} > Motor Vehicle Suspension Parts`,
  /** 2641 */ TRANSMISSAO: `${P} > Motor Vehicle Transmission & Drivetrain Parts`,
  /** 3020 */ RODAGEM: `${P} > Motor Vehicle Wheel Systems`,
  /** 8137 */ MOTOR_COMPLETO: `${P} > Motor Vehicle Engines`,
  /** 2820 */ MOTOR_PECAS: `${P} > Motor Vehicle Engine Parts`,
  /** 2550 */ OLEO: `${P} > Motor Vehicle Engine Oil Circulation`,
  /** 2727 */ COMBUSTIVEL: `${P} > Motor Vehicle Fuel Systems`,
  /** 908  */ ESCAPAMENTO: `${P} > Motor Vehicle Exhaust`,
  /** 2805 */ CLIMATIZACAO: `${P} > Motor Vehicle Climate Control`,
  /** 8231 */ ELETRICA: `${P} > Motor Vehicle Power & Electrical Systems`,
  /** 8234 */ SENSORES: `${P} > Motor Vehicle Sensors & Gauges`,
  /** 8228 */ REBOQUE: `${P} > Motor Vehicle Towing`,
} as const;

export type FacebookPartCategory = (typeof FB_PART)[keyof typeof FB_PART];

/**
 * Nome em português de cada cesta.
 *
 * Derivado do nome OFICIAL da taxonomia pt-BR do Google, tirando o sufixo
 * "para veículos motorizados", que se repete em 20 das 21 e só faz o combobox
 * ficar ilegível. Ex.: "Peças de suspensão para veículos motorizados" → "Peças
 * de suspensão". A cobertura não muda; o texto fica utilizável.
 */
export const FB_PART_LABEL: Record<string, string> = {
  [FB_PART.CARROCERIA]: "Lataria e carroceria",
  [FB_PART.ILUMINACAO]: "Faróis, lanternas e iluminação",
  [FB_PART.JANELAS]: "Vidros e peças de janela",
  [FB_PART.ESPELHOS]: "Retrovisores e espelhos",
  [FB_PART.BANCOS]: "Bancos e assentos",
  [FB_PART.INTERIOR]: "Acabamentos e acessórios internos",
  [FB_PART.ESTOFADOS]: "Tapetes e estofados",
  [FB_PART.CONTROLES]: "Comandos e controles",
  [FB_PART.FREIOS]: "Freios",
  [FB_PART.SUSPENSAO]: "Suspensão",
  [FB_PART.TRANSMISSAO]: "Direção, câmbio e transmissão",
  [FB_PART.RODAGEM]: "Rodas, pneus e cubos",
  [FB_PART.MOTOR_COMPLETO]: "Motor completo",
  [FB_PART.MOTOR_PECAS]: "Peças de motor",
  [FB_PART.OLEO]: "Circulação de óleo do motor",
  [FB_PART.COMBUSTIVEL]: "Sistema de combustível",
  [FB_PART.ESCAPAMENTO]: "Escapamento",
  [FB_PART.CLIMATIZACAO]: "Arrefecimento e ar-condicionado",
  [FB_PART.ELETRICA]: "Elétrica e alimentação",
  [FB_PART.SENSORES]: "Sensores e indicadores",
  [FB_PART.REBOQUE]: "Reboque e engate",
};

/**
 * Palavra do nome da peça → cesta.
 *
 * Montado a partir da FREQUÊNCIA REAL do catálogo (as 55 primeiras palavras
 * cobrem a maior parte do estoque), não de imaginação. Cada bloco começa pelas
 * palavras mais comuns.
 */
export const FACEBOOK_PART_MAP: Record<string, string> = {
  // ── Lataria e carroceria ────────────────────────────────────────────────
  macaneta: FB_PART.CARROCERIA,
  fechadura: FB_PART.CARROCERIA,
  trinco: FB_PART.CARROCERIA,
  dobradica: FB_PART.CARROCERIA,
  "limitador de porta": FB_PART.CARROCERIA,
  "trava eletrica": FB_PART.CARROCERIA,
  capo: FB_PART.CARROCERIA,
  paralama: FB_PART.CARROCERIA,
  parabarro: FB_PART.CARROCERIA,
  "para-barro": FB_PART.CARROCERIA,
  parachoque: FB_PART.CARROCERIA,
  "para-choque": FB_PART.CARROCERIA,
  "para choque": FB_PART.CARROCERIA,
  longarina: FB_PART.CARROCERIA,
  montante: FB_PART.CARROCERIA,
  spoiler: FB_PART.CARROCERIA,
  aerofolio: FB_PART.CARROCERIA,
  grade: FB_PART.CARROCERIA,
  moldura: FB_PART.CARROCERIA,
  friso: FB_PART.CARROCERIA,
  soleira: FB_PART.CARROCERIA,
  estribo: FB_PART.CARROCERIA,
  cacamba: FB_PART.CARROCERIA,
  assoalho: FB_PART.CARROCERIA,
  travessa: FB_PART.CARROCERIA,
  emblema: FB_PART.CARROCERIA,
  "porta dianteira": FB_PART.CARROCERIA,
  "porta traseira": FB_PART.CARROCERIA,
  "tampa traseira": FB_PART.CARROCERIA,
  "tampa do porta-malas": FB_PART.CARROCERIA,
  // "Amortecedor da tampa" é do porta-malas, não da suspensão. Chave mais
  // longa, então vence `amortecedor`.
  "amortecedor da tampa": FB_PART.CARROCERIA,
  "amortecedor tampa": FB_PART.CARROCERIA,

  // ── Faróis, lanternas e iluminação ──────────────────────────────────────
  farol: FB_PART.ILUMINACAO,
  farolete: FB_PART.ILUMINACAO,
  lanterna: FB_PART.ILUMINACAO,
  "luz de teto": FB_PART.ILUMINACAO,
  "luz de placa": FB_PART.ILUMINACAO,
  "farol de milha": FB_PART.ILUMINACAO,
  "farol milha": FB_PART.ILUMINACAO,
  neblina: FB_PART.ILUMINACAO,
  lampada: FB_PART.ILUMINACAO,
  "pisca alerta": FB_PART.CONTROLES,

  // ── Vidros e janelas ────────────────────────────────────────────────────
  vidro: FB_PART.JANELAS,
  parabrisa: FB_PART.JANELAS,
  "para-brisa": FB_PART.JANELAS,
  vigia: FB_PART.JANELAS,
  "quebra-vento": FB_PART.JANELAS,
  "quebra vento": FB_PART.JANELAS,
  pestana: FB_PART.JANELAS,
  // Desempata contra `motor` e `vidro`: é peça de janela, não de motor.
  "maquina de vidro": FB_PART.JANELAS,
  "maquina do vidro": FB_PART.JANELAS,
  "motor do vidro": FB_PART.JANELAS,
  "motor de vidro": FB_PART.JANELAS,

  // ── Retrovisores ────────────────────────────────────────────────────────
  retrovisor: FB_PART.ESPELHOS,

  // ── Bancos ──────────────────────────────────────────────────────────────
  banco: FB_PART.BANCOS,
  assento: FB_PART.BANCOS,
  encosto: FB_PART.BANCOS,
  "apoio de cabeca": FB_PART.BANCOS,

  // ── Interior ────────────────────────────────────────────────────────────
  acabamento: FB_PART.INTERIOR,
  forro: FB_PART.INTERIOR,
  revestimento: FB_PART.INTERIOR,
  "porta luvas": FB_PART.INTERIOR,
  "porta-luvas": FB_PART.INTERIOR,
  "porta copos": FB_PART.INTERIOR,
  "porta mala": FB_PART.INTERIOR,
  console: FB_PART.INTERIOR,
  cinzeiro: FB_PART.INTERIOR,
  "quebra-sol": FB_PART.INTERIOR,
  "quebra sol": FB_PART.INTERIOR,
  "para-sol": FB_PART.INTERIOR,
  puxador: FB_PART.INTERIOR,
  "alca de teto": FB_PART.INTERIOR,

  // ── Tapetes e estofados ─────────────────────────────────────────────────
  tapete: FB_PART.ESTOFADOS,
  carpete: FB_PART.ESTOFADOS,
  estofado: FB_PART.ESTOFADOS,
  forracao: FB_PART.ESTOFADOS,

  // ── Comandos e controles ────────────────────────────────────────────────
  botao: FB_PART.CONTROLES,
  interruptor: FB_PART.CONTROLES,
  comutador: FB_PART.CONTROLES,
  alavanca: FB_PART.CONTROLES,
  manete: FB_PART.CONTROLES,
  volante: FB_PART.CONTROLES,
  pedal: FB_PART.CONTROLES,
  "chave de seta": FB_PART.CONTROLES,
  "chave de luz": FB_PART.CONTROLES,
  "chave de ignicao": FB_PART.CONTROLES,
  "chave limpador": FB_PART.CONTROLES,

  // ── Freios ──────────────────────────────────────────────────────────────
  freio: FB_PART.FREIOS,
  pinca: FB_PART.FREIOS,
  pastilha: FB_PART.FREIOS,
  "disco de freio": FB_PART.FREIOS,
  tambor: FB_PART.FREIOS,
  abs: FB_PART.FREIOS,
  "servo freio": FB_PART.FREIOS,
  "cilindro de freio": FB_PART.FREIOS,
  "cilindro mestre": FB_PART.FREIOS,
  "reservatorio de fluido de freio": FB_PART.FREIOS,
  "reservatorio fluido de freio": FB_PART.FREIOS,
  "reservatorio de freio": FB_PART.FREIOS,

  // ── Suspensão ───────────────────────────────────────────────────────────
  amortecedor: FB_PART.SUSPENSAO,
  bieleta: FB_PART.SUSPENSAO,
  bandeja: FB_PART.SUSPENSAO,
  pivo: FB_PART.SUSPENSAO,
  batente: FB_PART.SUSPENSAO,
  coxim: FB_PART.SUSPENSAO,
  "mola helicoidal": FB_PART.SUSPENSAO,
  "barra estabilizadora": FB_PART.SUSPENSAO,
  "bucha da bandeja": FB_PART.SUSPENSAO,

  // ── Direção, câmbio e transmissão ───────────────────────────────────────
  cambio: FB_PART.TRANSMISSAO,
  transmissao: FB_PART.TRANSMISSAO,
  embreagem: FB_PART.TRANSMISSAO,
  plato: FB_PART.TRANSMISSAO,
  homocinetica: FB_PART.TRANSMISSAO,
  "semi-eixo": FB_PART.TRANSMISSAO,
  "semi eixo": FB_PART.TRANSMISSAO,
  semieixo: FB_PART.TRANSMISSAO,
  cardan: FB_PART.TRANSMISSAO,
  diferencial: FB_PART.TRANSMISSAO,
  cremalheira: FB_PART.TRANSMISSAO,
  "caixa de direcao": FB_PART.TRANSMISSAO,
  "caixa de cambio": FB_PART.TRANSMISSAO,
  "terminal de direcao": FB_PART.TRANSMISSAO,
  "coluna de direcao": FB_PART.TRANSMISSAO,

  // ── Rodas e pneus ───────────────────────────────────────────────────────
  roda: FB_PART.RODAGEM,
  pneu: FB_PART.RODAGEM,
  calota: FB_PART.RODAGEM,
  "cubo de roda": FB_PART.RODAGEM,
  "manga de eixo": FB_PART.RODAGEM,
  rolamento: FB_PART.RODAGEM,

  // ── Motor ───────────────────────────────────────────────────────────────
  // `motor` sozinho vai para PEÇAS de motor: em desmanche, "Suporte do Motor",
  // "Tubo Ressonador Motor" e "Cabeçote do Motor" são muito mais comuns que o
  // motor inteiro — e o motor inteiro é anunciado como "motor completo".
  motor: FB_PART.MOTOR_PECAS,
  "motor completo": FB_PART.MOTOR_COMPLETO,
  "motor parcial": FB_PART.MOTOR_COMPLETO,
  cabecote: FB_PART.MOTOR_PECAS,
  virabrequim: FB_PART.MOTOR_PECAS,
  biela: FB_PART.MOTOR_PECAS,
  pistao: FB_PART.MOTOR_PECAS,
  valvula: FB_PART.MOTOR_PECAS,
  carter: FB_PART.MOTOR_PECAS,
  polia: FB_PART.MOTOR_PECAS,
  tensor: FB_PART.MOTOR_PECAS,
  "correia dentada": FB_PART.MOTOR_PECAS,
  "corrente de distribuicao": FB_PART.MOTOR_PECAS,
  "comando de valvulas": FB_PART.MOTOR_PECAS,
  bronzina: FB_PART.MOTOR_PECAS,
  retentor: FB_PART.MOTOR_PECAS,
  coletor: FB_PART.MOTOR_PECAS,
  "coletor de admissao": FB_PART.MOTOR_PECAS,
  "bomba d agua": FB_PART.MOTOR_PECAS,
  "bomba de agua": FB_PART.MOTOR_PECAS,

  // ── Circulação de óleo ──────────────────────────────────────────────────
  "bomba de oleo": FB_PART.OLEO,
  "carter de oleo": FB_PART.OLEO,
  "filtro de oleo": FB_PART.OLEO,
  "vareta de oleo": FB_PART.OLEO,
  "radiador de oleo": FB_PART.OLEO,
  "trocador de calor": FB_PART.OLEO,

  // ── Combustível ─────────────────────────────────────────────────────────
  // `combustivel` sozinho cobre "Mangueira Combustível", "Cano de Combustível",
  // "Gargalo do Tanque de Combustível" — 10.196 peças começam por "mangueira" no
  // catálogo, e mangueira sozinha é ambígua demais para entrar.
  combustivel: FB_PART.COMBUSTIVEL,
  gargalo: FB_PART.COMBUSTIVEL,
  bico: FB_PART.COMBUSTIVEL,
  injetor: FB_PART.COMBUSTIVEL,
  flauta: FB_PART.COMBUSTIVEL,
  canister: FB_PART.COMBUSTIVEL,
  tbi: FB_PART.COMBUSTIVEL,
  "corpo de borboleta": FB_PART.COMBUSTIVEL,
  "bomba de combustivel": FB_PART.COMBUSTIVEL,
  "filtro de combustivel": FB_PART.COMBUSTIVEL,
  "tanque de combustivel": FB_PART.COMBUSTIVEL,
  "boia de combustivel": FB_PART.COMBUSTIVEL,

  // ── Escapamento ─────────────────────────────────────────────────────────
  escapamento: FB_PART.ESCAPAMENTO,
  escape: FB_PART.ESCAPAMENTO,
  catalisador: FB_PART.ESCAPAMENTO,
  silencioso: FB_PART.ESCAPAMENTO,
  ressonador: FB_PART.ESCAPAMENTO,
  "coletor de escape": FB_PART.ESCAPAMENTO,
  "tubo de escape": FB_PART.ESCAPAMENTO,

  // ── Arrefecimento e ar-condicionado ─────────────────────────────────────
  radiador: FB_PART.CLIMATIZACAO,
  ventoinha: FB_PART.CLIMATIZACAO,
  eletroventilador: FB_PART.CLIMATIZACAO,
  condensador: FB_PART.CLIMATIZACAO,
  evaporador: FB_PART.CLIMATIZACAO,
  intercooler: FB_PART.CLIMATIZACAO,
  aquecedor: FB_PART.CLIMATIZACAO,
  termostato: FB_PART.CLIMATIZACAO,
  "valvula termostatica": FB_PART.CLIMATIZACAO,
  "ar condicionado": FB_PART.CLIMATIZACAO,
  "ar-condicionado": FB_PART.CLIMATIZACAO,
  "compressor do ar": FB_PART.CLIMATIZACAO,
  // `reservatorio` sozinho é o de água/expansão, de longe o mais comum num
  // desmanche. Os outros três precisam de chave composta, senão caem aqui —
  // "Reservatório Fluido De Freio" ia parar em arrefecimento (medido na amostra).
  reservatorio: FB_PART.CLIMATIZACAO,
  "mangueira do radiador": FB_PART.CLIMATIZACAO,
  "mangueira de agua": FB_PART.CLIMATIZACAO,
  "mangueira de ar": FB_PART.CLIMATIZACAO,
  "duto de ar": FB_PART.CLIMATIZACAO,
  difusor: FB_PART.CLIMATIZACAO,

  // ── Elétrica ────────────────────────────────────────────────────────────
  chicote: FB_PART.ELETRICA,
  modulo: FB_PART.ELETRICA,
  central: FB_PART.ELETRICA,
  alternador: FB_PART.ELETRICA,
  bateria: FB_PART.ELETRICA,
  bobina: FB_PART.ELETRICA,
  vela: FB_PART.ELETRICA,
  rele: FB_PART.ELETRICA,
  fusivel: FB_PART.ELETRICA,
  conector: FB_PART.ELETRICA,
  "motor de partida": FB_PART.ELETRICA,
  "motor de arranque": FB_PART.ELETRICA,
  "caixa de fusiveis": FB_PART.ELETRICA,
  "cabo de vela": FB_PART.ELETRICA,

  // ── Sensores ────────────────────────────────────────────────────────────
  sensor: FB_PART.SENSORES,
  sonda: FB_PART.SENSORES,
  "sonda lambda": FB_PART.SENSORES,
  velocimetro: FB_PART.SENSORES,
  "painel de instrumentos": FB_PART.SENSORES,
  "conta giros": FB_PART.SENSORES,
  "computador de bordo": FB_PART.SENSORES,

  // ── Reboque ─────────────────────────────────────────────────────────────
  engate: FB_PART.REBOQUE,
  reboque: FB_PART.REBOQUE,
};
