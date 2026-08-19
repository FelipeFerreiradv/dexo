// De-para de VEÍCULO → `google_product_category` (taxonomia Google Product) do
// item de catálogo Meta. Espelha olx-category-map.ts, mas aqui o valor é a
// STRING do caminho da taxonomia (o Graph aceita o path completo ou o id
// numérico; usamos o path por legibilidade).
//
// A Meta usa `google_product_category` como sinal principal de categoria do
// catálogo (não há árvore própria consultável por API como a Magalu). Autopeças
// vive sob "Vehicles & Parts > Vehicle Parts & Accessories". Diferencia-se por
// tipo de veículo (moto / barco vs. carro), como na OLX.
//
// Escopo: v1 GLOBAL (Jotabê é o único seller hoje, majoritariamente peça de
// carro). Se entrar outro seller, migrar para mapa por conta (DB), como Magalu.

const MOTOR_VEHICLE_PARTS =
  "Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts";
const MOTORCYCLE_PARTS =
  "Vehicles & Parts > Vehicle Parts & Accessories > Motorcycle Parts";
const WATERCRAFT_PARTS =
  "Vehicles & Parts > Vehicle Parts & Accessories > Watercraft Parts";

// De-para veículo → categoria Google. A resolução casa por PALAVRA
// (word-boundary) no nome do produto — a chave mais longa vence. `\bmoto\b` NÃO
// casa "motor" nem "suporte do motor". Sem match → FACEBOOK_DEFAULT_CATEGORY. O
// produto pode sobrescrever com `fbCategory`/`googleProductCategory` explícito.
export const FACEBOOK_CATEGORY_MAP: Record<string, string> = {
  // Motos
  moto: MOTORCYCLE_PARTS,
  motos: MOTORCYCLE_PARTS,
  motocicleta: MOTORCYCLE_PARTS,
  motoneta: MOTORCYCLE_PARTS,
  scooter: MOTORCYCLE_PARTS,
  // Barcos e embarcações
  barco: WATERCRAFT_PARTS,
  lancha: WATERCRAFT_PARTS,
  jetski: WATERCRAFT_PARTS,
};

// Default: Motor Vehicle Parts (carros/caminhões/ônibus — o grosso da Jotabê).
// Sem match de veículo no nome, cai aqui (não em null) — o item publica com uma
// categoria válida.
export const FACEBOOK_DEFAULT_CATEGORY: string = MOTOR_VEHICLE_PARTS;

/**
 * Nome de exibição em português de cada categoria do catálogo.
 *
 * ⚠️ TRADUZ O RÓTULO, NUNCA O VALOR. O que vai para a Meta é o caminho da
 * taxonomia do Google, que existe só em inglês — traduzir o valor faria a Meta
 * recusar o item. Por isso o de-para é uma camada separada: a chave é o path
 * real (enviado ao canal) e o texto é apenas o que aparece na tela.
 */
export const FACEBOOK_CATEGORY_LABEL: Record<string, string> = {
  [MOTOR_VEHICLE_PARTS]: "Peças de carros, vans e utilitários",
  [MOTORCYCLE_PARTS]: "Peças de motos",
  [WATERCRAFT_PARTS]: "Peças de barcos e embarcações",
};
