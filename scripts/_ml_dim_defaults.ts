/**
 * Defaults de medidas para autopeças no Mercado Livre.
 * Estratégia em 3 camadas:
 *   1. Mapa explícito por categoria (top ML categories de autopeças JOTABÊ).
 *   2. Heurística por palavra-chave no título do anúncio.
 *   3. Default global conservador (cabe na maioria das peças pequenas).
 *
 * Todos os valores ficam DENTRO dos limites Mercado Envios padrão Brasil:
 *   - lado máx 100 cm
 *   - soma L+A+P máx 200 cm
 *   - peso máx 30 kg
 *
 * IMPORTANTE: estes valores são "seguros para destravar publicação", não exatos.
 * O vendedor pode ajustar caso a caso depois.
 */

export interface Dim {
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  weightKg: number;
  source: string; // descreve origem para auditoria
}

export const TIERS = {
  TINY: { heightCm: 10, widthCm: 10, lengthCm: 10, weightKg: 0.3 }, // sensores, conectores, parafusos
  SMALL: { heightCm: 15, widthCm: 15, lengthCm: 15, weightKg: 0.6 }, // maçanetas, fechaduras, botões
  SMALL_LONG: { heightCm: 10, widthCm: 10, lengthCm: 50, weightKg: 0.8 }, // guias, frisos
  MEDIUM: { heightCm: 25, widthCm: 25, lengthCm: 25, weightKg: 2 }, // motores limpador, módulos
  MEDIUM_FLAT: { heightCm: 15, widthCm: 40, lengthCm: 40, weightKg: 2 }, // forros, painéis pequenos
  LARGE: { heightCm: 30, widthCm: 40, lengthCm: 50, weightKg: 5 }, // faróis grandes, alternadores grandes
  XLARGE: { heightCm: 30, widthCm: 50, lengthCm: 80, weightKg: 12 }, // portas, paralamas
  XXLARGE: { heightCm: 30, widthCm: 70, lengthCm: 100, weightKg: 18 }, // tampas traseiras, capôs (sum=200, no limite)
} as const;

/**
 * Mapa explícito categoria → tier.
 * Cobre as categorias mais frequentes da auditoria.
 */
export const CATEGORY_TIER: Record<string, keyof typeof TIERS> = {
  // Maçanetas / puxadores
  MLB428983: "SMALL", // Maçaneta Interna
  MLB428985: "SMALL", // Maçaneta Externa
  MLB458571: "SMALL", // Puxador Porta
  // Portas e paralamas
  MLB101763: "XLARGE", // Porta
  MLB101764: "XLARGE", // Paralama
  MLB101765: "XXLARGE", // Tampa Traseira
  // Lanternas e faróis
  MLB22645: "LARGE", // Lanterna Traseira (bump após smoke-test: ML tem mínimo interno > MEDIUM)
  MLB7863: "LARGE", // Farol
  // Fechaduras
  MLB194431: "SMALL", // Fechadura Porta
  MLB194429: "SMALL", // Fechadura Porta Malas
  // Vidros / máquinas / módulos / botões
  MLB115598: "TINY", // Botão Vidro Elétrico
  MLB191714: "SMALL", // Módulo Vidro
  MLB191713: "SMALL_LONG", // Guia Vidro
  MLB116479: "MEDIUM", // Máquina Vidro
  MLB191715: "MEDIUM", // Máquina Vidro Manual
  // Painéis e instrumentos
  MLB63548: "MEDIUM_FLAT", // Painel Instrumentos
  MLB47089: "MEDIUM_FLAT", // Placa Circuito Painel
  // Motores pequenos
  MLB63512: "MEDIUM", // Motor Limpador Parabrisa
  MLB47131: "MEDIUM", // Alternador
  MLB190976: "MEDIUM", // Motor de Arranque
  // Reservatórios
  MLB193531: "SMALL", // Reservatório Água
  MLB193785: "TINY", // Tampa Reservatório
  // Injeção / sondas
  MLB192566: "TINY", // Bico Injetor
  MLB192358: "TINY", // Sonda Lambda
  // Difusores / acabamentos
  MLB47102: "SMALL", // Difusor de Ar
  MLB456265: "MEDIUM_FLAT", // Acabamento
  MLB191833: "SMALL_LONG", // Moldura Coluna
  // Retrovisores
  MLB63846: "SMALL", // Retrovisor
  // Forros
  MLB277543: "MEDIUM_FLAT", // Forro Tampa Porta Malas
  // Pedais / suportes
  MLB270299: "SMALL", // Pedal/Suporte Embreagem
  // Limitadores / borrachas
  MLB194800: "SMALL", // Limitador Porta
  MLB191717: "SMALL_LONG", // Borracha Porta

  // ===== Top 50 do fallback (aprovado pelo usuário) =====
  // Sistema injeção / combustão
  MLB192357: "SMALL", // TBI / Corpo Borboleta
  MLB22668: "TINY", // Bobina Ignição
  MLB47110: "MEDIUM", // Coletor Admissão
  MLB47115: "SMALL", // Bomba Combustível
  MLB47083: "SMALL", // Biela Pistão
  MLB192359: "SMALL_LONG", // Flauta Injeção
  MLB431174: "TINY", // Válvula Canister
  MLB63735: "MEDIUM", // Coletor Escape / Protetor Calor
  MLB430961: "TINY", // Válvula Solenóide
  // Coxins / suspensão
  MLB194805: "SMALL", // Coxim Câmbio
  MLB193902: "SMALL", // Coxim Motor
  MLB22709: "SMALL_LONG", // Amortecedor
  MLB193572: "MEDIUM", // Bandeja Suspensão
  MLB277942: "MEDIUM", // Montante / Manga Eixo
  // Limpadores
  MLB63583: "SMALL_LONG", // Braço Limpador Dianteiro
  MLB432952: "SMALL_LONG", // Braço Limpador Traseiro
  // Vidros / manivela
  MLB428984: "TINY", // Manivela Vidro Manual
  // Tanque combustível e tampas
  MLB188061: "SMALL", // Tampa Tanque Combustível
  MLB194752: "XLARGE", // Tanque Combustível
  MLB439500: "SMALL_LONG", // Gargalo Tanque
  // Motor / lubrificação
  MLB193934: "SMALL", // Polia Virabrequim
  MLB194052: "TINY", // Engrenagem Virabrequim
  MLB194174: "MEDIUM", // Sobre Carter
  MLB47091: "SMALL", // Bomba Água
  MLB63788: "TINY", // Carcaça Válvula Termostática
  MLB193935: "TINY", // Vareta Óleo
  MLB430189: "SMALL", // Tampa Corrente / Capa Correia
  // Filtragem ar
  MLB278120: "MEDIUM", // Caixa Filtro Ar
  MLB269576: "MEDIUM", // Defletor Ventoinha
  MLB193933: "SMALL_LONG", // Mangueira Filtro Ar
  // Acabamentos / interiores
  MLB31156: "SMALL_LONG", // Alça Teto
  MLB5665: "SMALL_LONG", // Soleira
  MLB456390: "SMALL_LONG", // Acabamento Coluna
  MLB6170: "SMALL_LONG", // Aplique Lateral
  MLB22701: "MEDIUM_FLAT", // Quebra Sol
  MLB22747: "TINY", // Luz Teto Cortesia
  MLB63389: "SMALL", // Suporte Tampa Bagagito
  MLB431858: "MEDIUM_FLAT", // Capa Painel
  MLB22704: "MEDIUM", // Console Câmbio
  MLB63687: "SMALL_LONG", // Acabamento Coluna Parabrisa
  // Elétrica
  MLB63806: "TINY", // Cabo Vela
  MLB431130: "SMALL", // Chicote Elétrico
  MLB191728: "SMALL", // Brake Light (Luz Freio)
  MLB432458: "SMALL", // Tampa Caixa Fusíveis
  MLB2221: "TINY", // Buzina
  // Cintos
  MLB194062: "SMALL_LONG", // Cinto Segurança
  // Climatização
  MLB430748: "SMALL", // Comando Ar Condicionado
  // Freio
  MLB63743: "SMALL", // Alavanca Freio Mão
  // Carroceria externa
  MLB63736: "MEDIUM_FLAT", // Grade Radiador / Churrasqueira
  MLB194789: "MEDIUM_FLAT", // Parabarro
};

/**
 * Heurística por palavra-chave no título.
 * Aplicada quando a categoria não está no mapa explícito.
 * Ordem importa — primeiras matches ganham.
 */
const KEYWORD_RULES: Array<{ pattern: RegExp; tier: keyof typeof TIERS }> = [
  { pattern: /capô|capo |tampa\s*(traseir|maleir|motor)|porta\s*malas/i, tier: "XXLARGE" },
  { pattern: /\bporta\b(?!\s*malas|\s*objetos|\s*copo)/i, tier: "XLARGE" },
  { pattern: /paralama|para[\s-]?choque|parachoque/i, tier: "XLARGE" },
  { pattern: /farol|grade\s*frontal|painel\s*frontal/i, tier: "LARGE" },
  { pattern: /banco\s|assento\b|encosto/i, tier: "XLARGE" },
  { pattern: /motor\s*(de\s*)?(arranque|partida|ventoinha|limpador)|alternador|compressor/i, tier: "MEDIUM" },
  { pattern: /módulo|modulo|central|ecu|caixa\s*fusível|bsi/i, tier: "SMALL" },
  { pattern: /lanterna|lantern/i, tier: "MEDIUM" },
  { pattern: /retrovisor|espelho/i, tier: "SMALL" },
  { pattern: /forro\b|painel\s*porta/i, tier: "MEDIUM_FLAT" },
  { pattern: /maçaneta|macaneta|puxador|fechadura/i, tier: "SMALL" },
  { pattern: /botão|botao|interruptor|chave\s*(seta|luz)/i, tier: "TINY" },
  { pattern: /sensor|sonda|bico\s*injetor|conector/i, tier: "TINY" },
  { pattern: /reservat[óo]rio|tanque\s*expans/i, tier: "SMALL" },
  { pattern: /guia\s*vidro|friso|moldura/i, tier: "SMALL_LONG" },
  { pattern: /borracha/i, tier: "SMALL_LONG" },
  { pattern: /pedal/i, tier: "SMALL" },
  { pattern: /vidro\s*el[ée]trico|m[áa]quina\s*vidro/i, tier: "MEDIUM" },
  { pattern: /coluna\s*direção|cremalheira|caixa\s*direção/i, tier: "MEDIUM" },
];

const FALLBACK_TIER: keyof typeof TIERS = "SMALL";

export function resolveDim(category: string, title: string): Dim {
  const tierFromCat = CATEGORY_TIER[category];
  if (tierFromCat) {
    return { ...TIERS[tierFromCat], source: `cat:${category}->${tierFromCat}` };
  }
  for (const r of KEYWORD_RULES) {
    if (r.pattern.test(title)) {
      return { ...TIERS[r.tier], source: `kw:${r.tier}` };
    }
  }
  return { ...TIERS[FALLBACK_TIER], source: `fallback:${FALLBACK_TIER}` };
}
