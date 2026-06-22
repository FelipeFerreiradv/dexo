/**
 * Parser determinístico de título de peça → entidades + chave de agrupamento.
 *
 * Módulo PURO (sem DB) compartilhado pelo job noturno (scripts/build-catalog-stats.ts)
 * e pelo endpoint GET /marketplace/internal/suggest. Consistência por construção:
 * ambos derivam `partType` e as colunas de lookup pela MESMA função, então a chave
 * gravada pelo job e a chave consultada pelo endpoint sempre alinham.
 *
 * Reaproveita infra existente:
 *  - `parseTitleToFields` + `BRANDS` de app/lib/product-parser.ts (marca/modelo/ano).
 *  - A mesma regex de ano (/\b(19|20)\d{2}\b/) do ml-catalog-suggestion.usecase
 *    (re-implementada aqui; tests/title-parse.spec.ts garante paridade).
 *
 * partType vem de um vocabulário curado de tipos de peça (o `pieceType` do
 * CategorySuggestionService é apenas o primeiro token de alias que casou — ruidoso
 * demais para agrupar). A posição (dianteiro/traseiro/esquerdo/...) é dobrada
 * dentro do partType porque muda a peça (ex.: "cubo-de-roda-dianteiro").
 */

import { BRANDS, parseTitleToFields } from "@/app/lib/product-parser";

// ──────────────────────────────────────────────────────────────────────────
// Normalização (o funil único)
// ──────────────────────────────────────────────────────────────────────────

// Marcas diacríticas combinantes (acentos) que sobram após normalize("NFD").
// Construída via RegExp para manter o fonte 100% ASCII.
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** NFD strip-acento + lowercase + colapsa espaços + trim. */
export function normalizeText(input?: string | null): string {
  if (typeof input !== "string") return "";
  return input
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** normalizeText e depois kebab: tudo que não é [a-z0-9] vira "-", colapsa repetições. */
export function kebab(input?: string | null): string {
  const n = normalizeText(input);
  return n
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Stopwords removidas antes do casamento de frases (espelha o espírito do
// STOPWORDS do CategorySuggestionService, mantido aqui para o módulo ser puro).
const STOPWORDS = new Set([
  "de",
  "da",
  "do",
  "das",
  "dos",
  "para",
  "pra",
  "por",
  "com",
  "sem",
  "na",
  "no",
  "nas",
  "nos",
  "em",
  "a",
  "o",
  "as",
  "os",
  "e",
  "ou",
  "um",
  "uma",
  "peca",
  "pç",
  "kit",
  // Quantificadores/agrupadores: o tipo de peça real vem em seguida
  // (ex.: "par de faróis", "jogo de molas" → "farois"/"molas").
  "par",
  "jogo",
  "jg",
  "conjunto",
  "cjt",
  "unidade",
  "und",
  "lado",
]);

// Palavras compostas: formas que devem ser unidas ANTES da remoção de stopwords
// (ex.: "para-choque" / "para choque" → "parachoque"), senão "para" some como
// stopword. Aplicadas no texto normalizado com hífen já virado espaço.
const COMPOUND_WORDS: Array<[RegExp, string]> = [
  [/\bpara\s?choques?\b/g, "parachoque"],
  [/\bpara\s?lamas?\b/g, "paralama"],
  [/\bpara\s?brisas?\b/g, "parabrisa"],
  [/\bpara\s?sol\b/g, "parasol"],
  [/\bpara\s?barros?\b/g, "parabarro"],
  [/\bpara\s?lamas?\b/g, "paralama"],
  [/\bsemi\s?eixos?\b/g, "semieixo"],
  [/\bbomba\s?d?\s?agua\b/g, "bombadagua"],
];

/** Texto normalizado, hífen→espaço, compostos unidos e SEM stopwords isoladas. */
export function stripStopwords(input?: string | null): string {
  let t = normalizeText(input).replace(/-/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, rep] of COMPOUND_WORDS) t = t.replace(re, rep);
  return t
    .split(" ")
    .filter((tok) => tok.length > 0 && !STOPWORDS.has(tok))
    .join(" ");
}

// ──────────────────────────────────────────────────────────────────────────
// Ano (mesma regex do ml-catalog-suggestion.usecase — paridade testada)
// ──────────────────────────────────────────────────────────────────────────

const MIN_YEAR = 1900;
const MAX_YEAR = 2100; // teto defensivo; o job aplica o teto fino (ano atual + 2)

/** Primeiro ano de 4 dígitos (19xx/20xx) no texto, ou null. */
export function parseYearToNumber(raw?: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n) || n < MIN_YEAR || n > MAX_YEAR) return null;
  return n;
}

/** Faixa {from,to} = min/max de TODOS os anos de 4 dígitos no texto. */
export function parseYearRange(raw?: string | null): {
  from: number | null;
  to: number | null;
} {
  if (!raw) return { from: null, to: null };
  const matches = Array.from(raw.matchAll(/\b(19|20)\d{2}\b/g))
    .map((m) => parseInt(m[0], 10))
    .filter((n) => Number.isFinite(n) && n >= MIN_YEAR && n <= MAX_YEAR);
  if (matches.length === 0) return { from: null, to: null };
  return { from: Math.min(...matches), to: Math.max(...matches) };
}

// ──────────────────────────────────────────────────────────────────────────
// Posição (dianteiro/traseiro/lateral + lado) — dobrada dentro do partType
// ──────────────────────────────────────────────────────────────────────────

// Cada grupo é mutuamente exclusivo; capturamos no máximo um de cada e juntamos
// em ordem canônica (eixo → lado → altura) para distinguir a peça.
const POSITION_GROUPS: Array<{ canonical: string; terms: string[] }> = [
  // Eixo
  {
    canonical: "dianteiro",
    terms: ["dianteiro", "dianteira", "diant", "frontal"],
  },
  { canonical: "traseiro", terms: ["traseiro", "traseira", "tras"] },
  // Lado (abreviações curtas/ambíguas como "dir"=direção ficam de fora)
  {
    canonical: "esquerdo",
    terms: ["esquerdo", "esquerda", "esq", "le", "motorista"],
  },
  {
    canonical: "direito",
    terms: ["direito", "direita", "ld", "passageiro", "carona"],
  },
  // Altura (só os termos inequívocos — "alto"/"baixo" colidem com peças)
  { canonical: "superior", terms: ["superior"] },
  { canonical: "inferior", terms: ["inferior"] },
];

/** Posição canônica (ex.: "dianteiro-esquerdo") presente no texto, ou null. */
export function extractPosition(text?: string | null): string | null {
  const tokens = new Set(normalizeText(text).replace(/-/g, " ").split(" "));
  const found: string[] = [];
  for (const group of POSITION_GROUPS) {
    if (group.terms.some((t) => tokens.has(t))) found.push(group.canonical);
  }
  return found.length > 0 ? found.join("-") : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Vocabulário de tipo de peça (curado). Frases em forma normalizada SEM
// stopwords; `label` é o kebab canônico (display/chave). Frases mais longas têm
// prioridade (casamento longest-first) para preferir o tipo mais específico.
// ──────────────────────────────────────────────────────────────────────────

// Curado a partir do catálogo real (mineração das peças cadastradas) + tipos
// comuns do mercado BR de autopeças/desmonte. `label` é o kebab canônico; as
// `phrases` (já em forma normalizada) incluem sinônimos, abreviações e plurais.
// O casamento é por POSIÇÃO MAIS À ESQUERDA no título (o tipo de peça quase
// sempre vem primeiro), com empate resolvido pela frase mais específica — então
// frases multi-palavra ("caixa de direcao") vencem o termo genérico ("caixa").
const PART_TYPES: Array<{ label: string; phrases: string[] }> = [
  // ── Carroceria / lataria / externo ──
  {
    label: "parachoque",
    phrases: ["parachoque", "para choque", "parachoques"],
  },
  { label: "paralama", phrases: ["paralama", "para lama", "paralamas"] },
  { label: "parabrisa", phrases: ["parabrisa", "para brisa"] },
  { label: "parabarro", phrases: ["parabarro", "para barro", "parabarros"] },
  {
    label: "grade",
    phrases: ["grade", "grades", "grade dianteira", "grade radiador"],
  },
  { label: "capo", phrases: ["capo", "capos"] },
  { label: "porta", phrases: ["porta", "portas"] },
  {
    label: "tampa-traseira",
    phrases: [
      "tampa traseira",
      "porta malas",
      "tampa porta malas",
      "tampa bagageiro",
    ],
  },
  {
    label: "portinhola",
    phrases: [
      "portinhola",
      "portinholas",
      "portinhola tanque",
      "portinhola combustivel",
    ],
  },
  {
    label: "retrovisor",
    phrases: ["retrovisor", "retrovisores", "espelho retrovisor"],
  },
  { label: "macaneta", phrases: ["macaneta", "macanetas", "puxador porta"] },
  {
    label: "limitador-de-porta",
    phrases: [
      "limitador porta",
      "limitador de porta",
      "limitador",
      "tirante porta",
      "tirante",
    ],
  },
  {
    label: "fechadura",
    phrases: [
      "fechadura",
      "fechaduras",
      "fechadura eletrica",
      "fechadura porta",
      "trava porta",
      "trava eletrica",
    ],
  },
  {
    label: "lanterna",
    phrases: ["lanterna", "lanternas", "lanterna traseira"],
  },
  {
    label: "farol-de-milha",
    phrases: ["farol milha", "farol neblina", "farol auxiliar"],
  },
  { label: "farol", phrases: ["farol", "farois", "farol dianteiro"] },
  { label: "pisca", phrases: ["pisca", "piscas", "seta", "lanterna pisca"] },
  { label: "spoiler", phrases: ["spoiler", "spoilers", "aerofolio"] },
  {
    label: "friso",
    phrases: ["friso", "frisos", "moldura", "molduras", "aplique"],
  },
  { label: "soleira", phrases: ["soleira", "soleiras", "protetor soleira"] },
  {
    label: "emblema",
    phrases: ["emblema", "emblemas", "logo", "logotipo", "simbolo", "letreiro"],
  },
  { label: "calota", phrases: ["calota", "calotas"] },
  { label: "roda", phrases: ["roda", "rodas", "aro", "aros"] },
  {
    label: "defletor",
    phrases: ["defletor", "defletores", "defletor ar", "calha", "calha chuva"],
  },
  {
    label: "quebra-sol",
    phrases: ["quebra sol", "tapa sol", "para sol", "parasol", "palheta sol"],
  },
  { label: "estribo", phrases: ["estribo", "estribos", "degrau"] },
  { label: "longarina", phrases: ["longarina", "longarinas"] },
  { label: "coluna", phrases: ["coluna", "colunas", "acabamento coluna"] },
  // ── Vidros ──
  { label: "vidro", phrases: ["vidro", "vidros", "vidro porta", "vigia"] },
  {
    label: "maquina-de-vidro",
    phrases: [
      "maquina vidro",
      "maquina de vidro",
      "motor vidro",
      "maquinas vidro",
    ],
  },
  { label: "pestana", phrases: ["pestana", "pestanas", "friso vidro"] },
  {
    label: "borracha",
    phrases: [
      "borracha",
      "borrachas",
      "guarnicao",
      "guarnicoes",
      "borracha porta",
    ],
  },
  // ── Suspensão / direção ──
  { label: "amortecedor", phrases: ["amortecedor", "amortecedores"] },
  { label: "mola", phrases: ["mola", "molas", "mola suspensao"] },
  { label: "bandeja", phrases: ["bandeja", "bandejas", "balanca", "balancas"] },
  { label: "pivo", phrases: ["pivo", "pivos"] },
  { label: "bieleta", phrases: ["bieleta", "bieletas"] },
  {
    label: "batente",
    phrases: ["batente", "batentes", "kit batente", "coxim amortecedor"],
  },
  { label: "coifa", phrases: ["coifa", "coifas"] },
  {
    label: "bucha",
    phrases: ["bucha", "buchas", "bucha bandeja", "bucha estabilizadora"],
  },
  {
    label: "cubo-de-roda",
    phrases: ["cubo roda", "cubo de roda", "cubo", "cubos"],
  },
  {
    label: "rolamento",
    phrases: ["rolamento", "rolamentos", "rolamento roda"],
  },
  {
    label: "terminal-de-direcao",
    phrases: [
      "terminal direcao",
      "terminal de direcao",
      "terminal",
      "terminais",
    ],
  },
  {
    label: "caixa-de-direcao",
    phrases: [
      "caixa direcao",
      "caixa de direcao",
      "setor direcao",
      "cremalheira",
    ],
  },
  {
    label: "coluna-de-direcao",
    phrases: ["coluna direcao", "coluna de direcao"],
  },
  {
    label: "bomba-de-direcao",
    phrases: ["bomba direcao", "bomba de direcao", "bomba hidraulica"],
  },
  { label: "ponta-de-eixo", phrases: ["ponta eixo", "ponta de eixo"] },
  {
    label: "manga-de-eixo",
    phrases: [
      "manga eixo",
      "manga de eixo",
      "manga",
      "montante manga",
      "montante",
    ],
  },
  { label: "semieixo", phrases: ["semieixo", "semi eixo", "semieixos"] },
  {
    label: "homocinetica",
    phrases: ["homocinetica", "junta homocinetica", "trizeta"],
  },
  {
    label: "barra-estabilizadora",
    phrases: ["barra estabilizadora", "estabilizador", "barra"],
  },
  {
    label: "braco-do-limpador",
    phrases: ["braco limpador", "braco do limpador", "haste limpador"],
  },
  { label: "braco-oscilante", phrases: ["braco oscilante", "braco suspensao"] },
  // ── Freio ──
  {
    label: "disco-de-freio",
    phrases: ["disco freio", "disco de freio", "discos freio"],
  },
  {
    label: "pastilha-de-freio",
    phrases: ["pastilha freio", "pastilha de freio", "pastilha", "pastilhas"],
  },
  {
    label: "pinca-de-freio",
    phrases: ["pinca freio", "pinca de freio", "pinca", "pincas"],
  },
  {
    label: "cilindro-de-freio",
    phrases: ["cilindro freio", "cilindro mestre", "cilindro roda"],
  },
  { label: "tambor-de-freio", phrases: ["tambor freio", "tambor", "tambores"] },
  {
    label: "servo-freio",
    phrases: ["servo freio", "servo de freio", "hidrovacuo"],
  },
  {
    label: "abs",
    phrases: ["abs", "modulo abs", "central abs", "bomba abs", "unidade abs"],
  },
  { label: "freio", phrases: ["freio", "freios", "freio mao", "freio de mao"] },
  // ── Motor / transmissão ──
  { label: "motor", phrases: ["motor", "motores"] },
  { label: "cabecote", phrases: ["cabecote", "cabecotes"] },
  { label: "bloco-motor", phrases: ["bloco motor", "bloco"] },
  { label: "biela", phrases: ["biela", "bielas"] },
  { label: "pistao", phrases: ["pistao", "pistoes", "kit pistao"] },
  { label: "virabrequim", phrases: ["virabrequim"] },
  {
    label: "comando-de-valvulas",
    phrases: [
      "comando valvulas",
      "comando de valvulas",
      "comando",
      "eixo comando",
    ],
  },
  { label: "valvula", phrases: ["valvula", "valvulas"] },
  { label: "balancim", phrases: ["balancim", "balancins"] },
  {
    label: "junta",
    phrases: ["junta", "juntas", "junta cabecote", "jogo junta"],
  },
  { label: "carter", phrases: ["carter", "carteres"] },
  {
    label: "coletor",
    phrases: ["coletor", "coletores", "coletor admissao", "coletor escape"],
  },
  { label: "turbo", phrases: ["turbo", "turbina", "turbinas"] },
  {
    label: "embreagem",
    phrases: [
      "embreagem",
      "kit embreagem",
      "plato",
      "disco embreagem",
      "atuador embreagem",
    ],
  },
  {
    label: "cambio",
    phrases: [
      "cambio",
      "cambios",
      "caixa cambio",
      "caixa de cambio",
      "transmissao",
    ],
  },
  { label: "diferencial", phrases: ["diferencial", "diferenciais"] },
  {
    label: "coxim",
    phrases: ["coxim", "coxins", "coxim motor", "calco motor", "coxim cambio"],
  },
  { label: "carburador", phrases: ["carburador", "carburadores"] },
  { label: "distribuidor", phrases: ["distribuidor"] },
  { label: "volante-motor", phrases: ["volante motor", "volante do motor"] },
  {
    label: "polia",
    phrases: ["polia", "polias", "polia virabrequim", "polia alternador"],
  },
  { label: "bomba-de-oleo", phrases: ["bomba oleo", "bomba de oleo"] },
  {
    label: "vareta-de-oleo",
    phrases: ["vareta oleo", "vareta de oleo", "vareta nivel"],
  },
  // ── Arrefecimento / escape ──
  { label: "radiador", phrases: ["radiador", "radiadores"] },
  {
    label: "ventoinha",
    phrases: ["ventoinha", "ventoinhas", "eletroventilador", "helice"],
  },
  { label: "mangueira", phrases: ["mangueira", "mangueiras"] },
  { label: "duto", phrases: ["duto", "dutos", "duto ar", "duto turbo"] },
  {
    label: "valvula-termostatica",
    phrases: ["valvula termostatica", "termostatica", "termostato"],
  },
  {
    label: "bomba-dagua",
    phrases: ["bomba dagua", "bomba agua", "bomba de agua"],
  },
  {
    label: "escapamento",
    phrases: ["escapamento", "silencioso", "ponteira", "abafador"],
  },
  { label: "catalisador", phrases: ["catalisador", "catalisadores"] },
  { label: "intercooler", phrases: ["intercooler"] },
  {
    label: "reservatorio",
    phrases: [
      "reservatorio",
      "reservatorios",
      "reservatorio agua",
      "reservatorio expansao",
      "reservatorio partida",
    ],
  },
  {
    label: "tampa-de-reservatorio",
    phrases: ["tampa reservatorio", "tampa de reservatorio"],
  },
  {
    label: "gargalo",
    phrases: ["gargalo", "gargalos", "gargalo tanque", "gargalo abastecimento"],
  },
  { label: "condensador", phrases: ["condensador", "condensadores"] },
  { label: "evaporador", phrases: ["evaporador", "caixa evaporadora"] },
  {
    label: "compressor-de-ar",
    phrases: ["compressor ar", "compressor", "compressor ar condicionado"],
  },
  // ── Combustível / filtros ──
  {
    label: "tanque-de-combustivel",
    phrases: [
      "tanque combustivel",
      "tanque de combustivel",
      "tanque",
      "tanques",
    ],
  },
  {
    label: "bomba-de-combustivel",
    phrases: [
      "bomba combustivel",
      "bomba de combustivel",
      "bomba gasolina",
      "refil bomba",
    ],
  },
  {
    label: "flauta",
    phrases: [
      "flauta",
      "flautas",
      "flauta injecao",
      "flauta combustivel",
      "tubo distribuidor",
    ],
  },
  {
    label: "bico-injetor",
    phrases: ["bico injetor", "injetor", "injetores", "bicos"],
  },
  {
    label: "corpo-de-borboleta",
    phrases: ["corpo borboleta", "corpo de borboleta", "tbi", "corpo injecao"],
  },
  {
    label: "sonda-lambda",
    phrases: ["sonda lambda", "sonda", "sondas"],
  },
  {
    label: "filtro",
    phrases: [
      "filtro",
      "filtros",
      "filtro oleo",
      "filtro ar",
      "filtro combustivel",
    ],
  },
  {
    label: "tampa-de-tanque",
    phrases: ["tampa tanque", "tampa de tanque", "tampa combustivel"],
  },
  // ── Correia / acessórios do motor ──
  {
    label: "correia",
    phrases: ["correia", "correias", "correia dentada", "correia alternador"],
  },
  {
    label: "tensor",
    phrases: ["tensor", "tensores", "tensor correia", "esticador"],
  },
  // ── Elétrica / eletrônica ──
  { label: "alternador", phrases: ["alternador", "alternadores"] },
  {
    label: "motor-de-arranque",
    phrases: [
      "motor arranque",
      "motor de arranque",
      "motor partida",
      "arranque",
    ],
  },
  { label: "bobina", phrases: ["bobina", "bobinas", "bobina ignicao"] },
  { label: "sensor", phrases: ["sensor", "sensores"] },
  {
    label: "modulo",
    phrases: [
      "modulo",
      "modulos",
      "central",
      "centralina",
      "ecu",
      "unidade comando",
    ],
  },
  {
    label: "vela",
    phrases: ["vela", "velas", "vela ignicao", "vela aquecedora"],
  },
  { label: "chicote", phrases: ["chicote", "chicotes", "chicote eletrico"] },
  { label: "rele", phrases: ["rele", "reles"] },
  { label: "bateria", phrases: ["bateria", "baterias"] },
  {
    label: "caixa-de-fusivel",
    phrases: ["caixa fusivel", "caixa de fusivel", "porta fusivel"],
  },
  { label: "fusivel", phrases: ["fusivel", "fusiveis"] },
  {
    label: "chave-de-seta",
    phrases: [
      "chave seta",
      "chave de seta",
      "comando seta",
      "alavanca seta",
      "manete seta",
    ],
  },
  {
    label: "botao",
    phrases: [
      "botao",
      "botoes",
      "botao pisca",
      "botao vidro",
      "interruptor",
      "interruptores",
    ],
  },
  {
    label: "chave",
    phrases: ["chave", "chaves", "comutador", "chave ignicao"],
  },
  { label: "buzina", phrases: ["buzina", "buzinas"] },
  {
    label: "alto-falante",
    phrases: [
      "alto falante",
      "alto falantes",
      "auto falante",
      "falante",
      "corneta",
      "tweeter",
    ],
  },
  { label: "antena", phrases: ["antena", "antenas"] },
  { label: "atuador", phrases: ["atuador", "atuadores"] },
  {
    label: "cabo",
    phrases: [
      "cabo",
      "cabos",
      "cabo vela",
      "cabo acelerador",
      "cabo embreagem",
      "cabo freio",
    ],
  },
  { label: "soquete", phrases: ["soquete", "soquetes", "conector"] },
  { label: "lampada", phrases: ["lampada", "lampadas"] },
  // ── Interior ──
  {
    label: "painel",
    phrases: ["painel", "paineis", "painel instrumentos", "tablier"],
  },
  {
    label: "banco",
    phrases: ["banco", "bancos", "assento", "assentos", "encosto", "encostos"],
  },
  { label: "volante", phrases: ["volante", "volantes"] },
  {
    label: "cinto-de-seguranca",
    phrases: ["cinto seguranca", "cinto de seguranca", "cinto", "cintos"],
  },
  { label: "airbag", phrases: ["airbag", "airbags", "air bag", "bolsa ar"] },
  { label: "console", phrases: ["console", "consoles", "console central"] },
  {
    label: "porta-luvas",
    phrases: ["porta luvas", "portaluvas", "porta objetos"],
  },
  {
    label: "forro",
    phrases: ["forro", "forros", "forro porta", "forro teto", "revestimento"],
  },
  {
    label: "acabamento",
    phrases: ["acabamento", "acabamentos", "friso interno", "moldura interna"],
  },
  { label: "tapete", phrases: ["tapete", "tapetes", "carpete"] },
  {
    label: "pedal",
    phrases: [
      "pedal",
      "pedais",
      "pedal acelerador",
      "pedal freio",
      "pedal embreagem",
    ],
  },
  {
    label: "alavanca-de-marcha",
    phrases: [
      "alavanca marcha",
      "alavanca de marcha",
      "alavanca cambio",
      "manopla cambio",
      "trambulador",
    ],
  },
  {
    label: "alavanca",
    phrases: ["alavanca", "alavancas", "manete", "manopla"],
  },
  {
    label: "difusor-de-ar",
    phrases: ["difusor ar", "difusor", "difusores", "saida ar", "aerador"],
  },
  {
    label: "alca-de-teto",
    phrases: ["alca teto", "alca de teto", "alca", "alcas", "pega mao"],
  },
  {
    label: "luz-de-teto",
    phrases: [
      "luz teto",
      "luz de teto",
      "plafonier",
      "lanterna teto",
      "luz interna",
    ],
  },
  { label: "luz", phrases: ["luz", "luzes", "luz placa"] },
  { label: "cinzeiro", phrases: ["cinzeiro", "cinzeiros"] },
  {
    label: "acendedor",
    phrases: [
      "acendedor",
      "acendedor cigarro",
      "isqueiro",
      "tomada acendedor",
      "tomada 12v",
      "acendedor 12v",
      "tomada usb",
    ],
  },
  // ── Fixação / chaparia / genéricos (fallback — só vencem quando lideram) ──
  {
    label: "suporte",
    phrases: ["suporte", "suportes", "mao francesa", "berco"],
  },
  {
    label: "tampa-de-valvulas",
    phrases: [
      "tampa valvulas",
      "tampa de valvulas",
      "tampa cabecote",
      "tampa motor",
    ],
  },
  { label: "tampa", phrases: ["tampa", "tampas"] },
  { label: "caixa", phrases: ["caixa", "caixas", "caixa ar"] },
  {
    label: "capa",
    phrases: ["capa", "capas", "capa estepe", "capa retrovisor"],
  },
  { label: "tubo", phrases: ["tubo", "tubos", "cano", "canos"] },
  {
    label: "chapa",
    phrases: [
      "chapa",
      "chapas",
      "assoalho",
      "painel dianteiro",
      "painel traseiro",
    ],
  },
];

// Índice plano (frase normalizada+stripada → label) ordenado por nº de palavras
// desc e comprimento desc, para casamento longest-first.
const PART_TYPE_INDEX: Array<{ phrase: string; words: number; label: string }> =
  PART_TYPES.flatMap((pt) =>
    pt.phrases.map((p) => {
      const phrase = stripStopwords(p);
      return { phrase, words: phrase.split(" ").length, label: pt.label };
    }),
  )
    .filter((e) => e.phrase.length > 0)
    .sort((a, b) => b.words - a.words || b.phrase.length - a.phrase.length);

/**
 * Tipo de peça canônico (kebab), com a POSIÇÃO dobrada quando presente
 * (ex.: "cubo-de-roda-dianteiro"). null quando nenhum tipo conhecido casa.
 *
 * Estratégia: a frase conhecida MAIS À ESQUERDA vence (em título de autopeça o
 * tipo quase sempre vem primeiro — "limitador de porta", "suporte do parachoque"
 * → limitador/suporte, não porta/parachoque). Empate de posição → frase mais
 * específica (mais palavras, depois mais longa). Robusto a "cubo de roda" vs
 * "cubo roda" porque casa no texto normalizado e sem stopwords.
 */
export function extractPartType(text?: string | null): string | null {
  const stripped = stripStopwords(text);
  if (!stripped) return null;
  const padded = ` ${stripped} `;
  let best: { idx: number; words: number; len: number; label: string } | null =
    null;
  for (const entry of PART_TYPE_INDEX) {
    const idx = padded.indexOf(` ${entry.phrase} `);
    if (idx === -1) continue;
    const cand = {
      idx,
      words: entry.words,
      len: entry.phrase.length,
      label: entry.label,
    };
    if (
      best === null ||
      cand.idx < best.idx ||
      (cand.idx === best.idx && cand.words > best.words) ||
      (cand.idx === best.idx &&
        cand.words === best.words &&
        cand.len > best.len)
    ) {
      best = cand;
    }
  }
  if (!best) return null;
  const position = extractPosition(text);
  return position ? `${best.label}-${position}` : best.label;
}

// ──────────────────────────────────────────────────────────────────────────
// Parse completo do título (caminho do ENDPOINT)
// ──────────────────────────────────────────────────────────────────────────

export interface TitleParts {
  /** Tipo de peça já com posição dobrada (kebab), ou null. */
  partType: string | null;
  /** Posição isolada (transparência/depuração). */
  position: string | null;
  /** Marca canônica (ex.: "Fiat"), ou null. */
  brand: string | null;
  /** Modelo heurístico (ex.: "UNO"), ou null. */
  model: string | null;
  /** Versão — não extraída do título livre no MVP (sempre null). */
  version: string | null;
  /** Ano único (4 dígitos), ou null. */
  year: number | null;
}

/** Parse determinístico do título livre para o endpoint. */
export function parseTitleToParts(title: string): TitleParts {
  const fields = parseTitleToFields(title || "");
  return {
    partType: extractPartType(title),
    position: extractPosition(title),
    brand: fields.brand ?? null,
    model: fields.model ?? null,
    version: null,
    year: parseYearToNumber(title),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Colunas de lookup + matchKey (usados por BOTH job e endpoint)
// ──────────────────────────────────────────────────────────────────────────

/** Sentinela usada nas colunas de lookup quando o campo não se aplica. */
export const ANY = "*";

export interface LookupInput {
  partType: string | null;
  brand?: string | null;
  model?: string | null;
  version?: string | null;
}

export interface LookupColumns {
  partType: string;
  brand: string;
  model: string;
  version: string;
}

const col = (v?: string | null): string => {
  const k = kebab(v);
  return k.length > 0 ? k : ANY;
};

/**
 * Colunas normalizadas de lookup. partType já vem kebab/dobrado do extractPartType,
 * mas re-kebabamos por segurança. brand/model/version → kebab ou "*".
 */
export function buildLookupColumns(input: LookupInput): LookupColumns {
  return {
    partType: col(input.partType),
    brand: col(input.brand),
    model: col(input.model),
    version: col(input.version),
  };
}

export interface MatchKeyInput extends LookupInput {
  yearFrom?: number | null;
  yearTo?: number | null;
}

/** Chave canônica "partType|brand|model|version|yearFrom-yearTo" (display/upsert). */
export function buildMatchKey(input: MatchKeyInput): string {
  const c = buildLookupColumns(input);
  const yearSeg =
    input.yearFrom != null || input.yearTo != null
      ? `${input.yearFrom ?? ""}-${input.yearTo ?? ""}`
      : ANY;
  return [c.partType, c.brand, c.model, c.version, yearSeg].join("|");
}
