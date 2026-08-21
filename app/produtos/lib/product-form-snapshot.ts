/**
 * Serializador ÚNICO do formulário de novo produto — usado pelo rascunho
 * automático (Bloco 4) e pelo histórico de cadastros (Bloco 3).
 *
 * Um serializador só, duas políticas: o que é PERSISTIDO é o mesmo nos dois
 * casos; o que é APLICADO de volta muda (o rascunho restaura tudo, o histórico
 * copia só o que faz sentido repetir entre peças parecidas).
 *
 * Puro: sem React, sem `window`, sem rede. O acesso a storage vive em
 * `product-form-storage.ts`.
 */

/** Versão do payload. Snapshot de versão desconhecida é descartado em silêncio. */
export const SNAPSHOT_VERSION = 1;

/**
 * Campos do formulário que NUNCA são serializados.
 *
 * `sku` é o mais importante e o mais perigoso: ele é único por tenant
 * (`@@unique([userId, sku])`) e vem do servidor a cada abertura
 * (`fetchNextSku` popula `autoSuggestedSkuRef`). O `onSubmit` decide entre
 * `autoSku: true` (campo vazio ou igual à sugestão) e SKU manual comparando o
 * valor digitado com essa ref. Restaurar um SKU velho faria o submit tomar o
 * caminho manual e enviar um código que outro cadastro já pode ter consumido.
 */
export const NEVER_PERSISTED_FIELDS = ["sku"] as const;

/**
 * Campos que o HISTÓRICO nunca copia, mesmo estando no snapshot.
 *
 *  - `sku`         nunca chega aqui: não é sequer persistido
 *                  (`NEVER_PERSISTED_FIELDS`). É único por tenant, vem do
 *                  servidor a cada abertura, e restaurar um antigo faria o
 *                  submit tomar o caminho de SKU manual.
 *  - `imageUrl` / `imageUrls`  a imagem é do produto físico, nunca do anterior.
 *  - `costPrice` / `markup`  o custo é da peça específica, e o markup é
 *                  derivado dele — copiar um sem o outro produz margem errada.
 *  - ids e códigos únicos (`mlCatalogProductId`, `scrapId`).
 *
 * `partNumber`, `stock`, `name` e `price` SAÍRAM desta lista em 05/08/2026 a
 * pedido do Felipe: quem cadastra peças parecidas em sequência quer esses
 * campos pré-preenchidos. A política de merge continua sendo a mesma —
 * `applyProductHistory` só preenche campo VAZIO e nunca sobrescreve o que o
 * usuário digitou (ver `tryFillString` / `tryFillNumber`).
 */
export const HISTORY_BLOCKED_FIELDS = [
  "sku",
  "imageUrl",
  "imageUrls",
  "costPrice",
  "markup",
  "mlCatalogProductId",
  "scrapId",
] as const;

export interface CompatibilitySnapshot {
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  version?: string | null;
}

/** A sucata como o rascunho a guarda. Só `id` é garantido. */
export interface ScrapSnapshot {
  id: string;
  label?: string;
  brand?: string;
  model?: string;
  year?: string;
  version?: string;
  plate?: string;
}

export interface ProductFormSnapshot {
  /** Versão do payload. */
  v: number;
  /** Momento da serialização (epoch ms) — base do TTL do rascunho. */
  savedAt: number;
  /** Valores do react-hook-form, menos os campos nunca persistidos. */
  values: Record<string, unknown>;
  /** Estado que vive FORA do react-hook-form e vai no payload do submit. */
  compatibilities: CompatibilitySnapshot[];
  /**
   * Posição das compatibilidades ("Dianteira", "Esquerda"). Também vive fora do
   * react-hook-form.
   *
   * Opcional: snapshot gravado antes desta versão não tem o campo e cai em lista
   * vazia — mesmo tratamento do `defaultStock`. Não vale mexer no
   * SNAPSHOT_VERSION por isso: subir a versão descartaria em silêncio todo
   * rascunho aberto no navegador de quem está trabalhando na hora do deploy.
   */
  compatibilityPositions?: string[];
  /**
   * Sucata vinculada (vira `scrapId`).
   *
   * Guarda o VEICULO inteiro, nao so o id, porque quem restaura precisa
   * desenhar a opcao do seletor — e o lote pode nao estar mais na lista de
   * `AVAILABLE` quando o rascunho voltar (foi esgotado, ou o tenant tem mais
   * de 100 lotes). Com so o id, restaurar significaria seleciona um valor
   * sem `<option>` correspondente, e dentro de um <form> o Radix devolve a
   * PRIMEIRA opcao pelo `onValueChange` — que aqui e "Nenhuma sucata", e
   * apaga marca/modelo/ano/versao/veiculo. Ver `scrap-link-section.tsx`.
   *
   * Campos do veiculo sao opcionais: rascunho gravado antes de 21/08/2026
   * so tem `id`, e o TTL de 24h faz esses sumirem sozinhos.
   */
  scrap: ScrapSnapshot | null;
  /** Rótulo exibido da categoria Magalu (o id está em `values.magaluCategory`). */
  magaluCategoryLabel: string | null;
  /** Seção em que o usuário estava (índice do scroll). */
  currentStep: number | null;
  /** Só para exibir no histórico — nunca reaplicado. */
  label: { name: string; sku: string | null };
  /**
   * `defaultStock` das preferências do usuário no momento em que o modal abriu.
   *
   * Existe só para `hasMeaningfulContent` conseguir distinguir "o usuário
   * digitou a quantidade" de "o formulário abriu com o padrão do tenant". Num
   * desmanche `defaultStock` costuma ser 1, então sem esta referência bastaria
   * abrir e fechar o modal para o sistema achar que há trabalho a salvar e
   * perguntar "continuar de onde parou?" sobre um formulário intocado.
   *
   * Opcional: rascunhos gravados antes desta versão não têm o campo e caem no
   * fallback `0`, que era o comportamento anterior.
   */
  defaultStock?: number | null;
}

export interface SerializeInput {
  values: Record<string, unknown>;
  compatibilities: CompatibilitySnapshot[];
  compatibilityPositions?: string[];
  scrap?: ScrapSnapshot | null;
  magaluCategoryLabel?: string | null;
  currentStep?: number | null;
  /** Ver `ProductFormSnapshot.defaultStock`. */
  defaultStock?: number | null;
  /** Injetado para manter a função pura e testável com relógio fixo. */
  now: number;
}

/**
 * Monta o snapshot. Nada de base64, blob, token ou PII além do que o próprio
 * usuário digitou — as imagens já são URLs devolvidas pelo `/upload/image`,
 * então entram como string e custam nada.
 */
export function serializeProductForm(
  input: SerializeInput,
): ProductFormSnapshot {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.values ?? {})) {
    if ((NEVER_PERSISTED_FIELDS as readonly string[]).includes(k)) continue;
    if (v === undefined) continue;
    values[k] = v;
  }

  return {
    v: SNAPSHOT_VERSION,
    savedAt: input.now,
    values,
    compatibilities: (input.compatibilities ?? []).map((c) => ({
      brand: c.brand,
      model: c.model,
      yearFrom: c.yearFrom ?? null,
      yearTo: c.yearTo ?? null,
      version: c.version ?? null,
    })),
    compatibilityPositions: (input.compatibilityPositions ?? []).filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    ),
    scrap: input.scrap ?? null,
    magaluCategoryLabel: input.magaluCategoryLabel ?? null,
    currentStep: input.currentStep ?? null,
    label: {
      name: String(input.values?.name ?? "").trim(),
      sku: (input.values?.sku as string | undefined)?.trim() || null,
    },
    defaultStock: input.defaultStock ?? null,
  };
}

/**
 * Valida um snapshot vindo do storage. Devolve `null` para qualquer coisa que
 * não seja exatamente o formato esperado — JSON corrompido, versão
 * desconhecida, campos com o tipo errado. Descarte SILENCIOSO: o usuário não
 * precisa saber que havia um rascunho ilegível.
 */
/**
 * A sucata vinda do localStorage, saneada.
 *
 * Isto aqui é entrada NÃO CONFIÁVEL: o valor pode ter sido editado à mão, ou
 * ter sido gravado por uma versão anterior do app. E o resultado agora vira
 * uma `<option>` do seletor, então um `brand` que não seja string chegaria a
 * ser renderizado. Sem `id` utilizável não há o que restaurar.
 */
function parseScrap(v: unknown): ScrapSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return null;
  const texto = (x: unknown): string | undefined =>
    typeof x === "string" && x.trim() ? x : undefined;
  return {
    id,
    label: texto(o.label),
    brand: texto(o.brand),
    model: texto(o.model),
    year: texto(o.year),
    version: texto(o.version),
    plate: texto(o.plate),
  };
}

export function parseSnapshot(raw: unknown): ProductFormSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<ProductFormSnapshot>;
  if (s.v !== SNAPSHOT_VERSION) return null;
  if (typeof s.savedAt !== "number" || !Number.isFinite(s.savedAt)) return null;
  if (!s.values || typeof s.values !== "object" || Array.isArray(s.values)) {
    return null;
  }
  return {
    v: SNAPSHOT_VERSION,
    savedAt: s.savedAt,
    values: s.values as Record<string, unknown>,
    compatibilities: Array.isArray(s.compatibilities) ? s.compatibilities : [],
    compatibilityPositions: Array.isArray(s.compatibilityPositions)
      ? s.compatibilityPositions.filter(
          (p): p is string => typeof p === "string",
        )
      : [],
    scrap: parseScrap(s.scrap),
    // `defaultStock` FICAVA PARA TRÁS AQUI.
    //
    // `hasMeaningfulContent` compara o `stock` com este padrão para não
    // perguntar "continuar de onde parou?" sobre um formulário intocado num
    // tenant cujo padrão é 1 (o caso do desmanche). Como o campo sumia na
    // volta do localStorage, a MESMA função respondia coisas diferentes para
    // o mesmo rascunho, conforme ele viesse da memória ou do disco: no disco
    // o padrão virava 0 e a comparação perdia o sentido.
    defaultStock:
      typeof s.defaultStock === "number" && Number.isFinite(s.defaultStock)
        ? s.defaultStock
        : null,
    magaluCategoryLabel: s.magaluCategoryLabel ?? null,
    currentStep: typeof s.currentStep === "number" ? s.currentStep : null,
    label: {
      name: String(s.label?.name ?? ""),
      sku: s.label?.sku ?? null,
    },
  };
}

/** Snapshot expirado? `ttlMs <= 0` desliga a expiração. */
export function isExpired(
  snapshot: ProductFormSnapshot,
  now: number,
  ttlMs: number,
): boolean {
  if (ttlMs <= 0) return false;
  return now - snapshot.savedAt > ttlMs;
}

/**
 * O formulário tem algo digitado que valha a pena guardar?
 *
 * Evita gravar rascunho de um modal que só foi aberto e fechado: os
 * `defaultValues` sozinhos não são rascunho. `description` e `costPrice` ficam
 * de fora da conta porque a abertura os pré-preenche sozinha
 * (`fetchDefaultDescription`), e `stock`/`price` porque têm default numérico.
 */
/**
 * Campos cuja presença significa "há trabalho do usuário aqui, vale salvar".
 *
 * `price` entrou em 05/08/2026: o formulário abre com 0 e nada o pré-preenche,
 * então qualquer valor diferente de zero foi digitado. `stock` NÃO está na
 * lista porque é pré-preenchido por `user.defaultStock` — ele é avaliado à
 * parte, comparando com o padrão do tenant (ver `hasMeaningfulContent`).
 *
 * `description`, `costPrice` e `markup` seguem de fora pelo mesmo motivo do
 * `stock`: os três podem vir das preferências do usuário, e contá-los faria
 * abrir-e-fechar o modal virar um "continuar de onde parou?" sobre um
 * formulário intocado.
 */
const MEANINGFUL_FIELDS = [
  "name",
  "price",
  "brand",
  "model",
  "year",
  "version",
  "category",
  "partNumber",
  "sourceVehicle",
  "quality",
  "location",
  "locationId",
  "imageUrl",
  "mlCategory",
  "shopeeCategory",
  "magaluCategory",
] as const;

export function hasMeaningfulContent(snapshot: ProductFormSnapshot): boolean {
  if (snapshot.compatibilities.length > 0) return true;
  // Posição só existe por clique explícito — nada a pré-preenche —, então ela
  // nunca cria o falso "continuar de onde parou?" que o `stock` acima evita.
  if ((snapshot.compatibilityPositions?.length ?? 0) > 0) return true;
  const attrs = snapshot.values.attributes;
  if (attrs && typeof attrs === "object" && Object.keys(attrs).length > 0) {
    return true;
  }
  const urls = snapshot.values.imageUrls;
  if (Array.isArray(urls) && urls.length > 0) return true;
  // Estoque conta como conteúdo quando é MAIOR QUE ZERO e DIFERE do padrão do
  // tenant com que o modal abriu. As duas condições são necessárias:
  //
  //  - sem a comparação com o padrão, um tenant com `defaultStock = 1` (o caso
  //    comum num desmanche, onde cada peça é única) veria a pergunta de
  //    restauração toda vez que abrisse e fechasse o modal sem digitar nada;
  //  - sem o `> 0`, o formulário RECÉM-ZERADO (`reset()` devolve `stock` a 0)
  //    passaria a contar como conteúdo para esse mesmo tenant, e o autosave
  //    gravaria um rascunho vazio por cima do que o usuário tinha digitado.
  //
  // Zero é "sem estoque", que neste domínio é o mesmo que vazio — o preço
  // segue a mesma regra via `MEANINGFUL_FIELDS`.
  const stock = snapshot.values.stock;
  const stockPadrao = snapshot.defaultStock ?? 0;
  if (typeof stock === "number" && Number.isFinite(stock)) {
    if (stock > 0 && stock !== stockPadrao) return true;
  }
  return MEANINGFUL_FIELDS.some((f) => {
    const v = snapshot.values[f];
    return typeof v === "string" ? v.trim().length > 0 : Boolean(v);
  });
}
