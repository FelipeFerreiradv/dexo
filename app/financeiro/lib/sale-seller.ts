// BLOCO B — vendedor da venda.
//
// QUEM VENDEU não é a mesma pergunta que QUEM OPEROU. No balcão, o caixa
// frequentemente lança a venda do balconista, e a comissão é de quem vendeu.
// Por isso o campo é uma COLUNA própria (`Receivable.sellerUserId`) e não o
// autor que a timeline (BLOCO H) já registra — aquele responde "quem clicou",
// que é auditoria, não negócio.
//
// Decisões de produto (14/08):
//  - o seletor nasce preenchido com quem está logado e é trocável num clique:
//    zero fricção no caso comum, correto no caso de comissão;
//  - a lista é o admin + todo colaborador ATIVO do tenant, sem configuração
//    prévia — mesma semântica das permissões existentes, cujo default é
//    permitir justamente para não regredir;
//  - o vendedor é corrigível DEPOIS, inclusive em venda paga, porque vendedor
//    errado é exatamente o que se descobre no fechamento. A troca entra no
//    histórico da venda, e é a trilha que protege a comissão de quem estava
//    certo.
//
// Módulo PURO (sem I/O): serve ao backend e ao bundle.

/**
 * Flag de BACKEND. Ausente ⇒ nada é gravado na coluna nova e o `data` dos
 * INSERT/UPDATE fica byte-idêntico ao de hoje. É o que torna seguro subir o
 * código enquanto as flags ainda estão desligadas.
 */
export function isSaleSellerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SALE_SELLER_ENABLED === "1";
}

// Referência literal a process.env.NEXT_PUBLIC_* para o Next inlinar.
const SALE_SELLER_UI_ENABLED =
  process.env.NEXT_PUBLIC_SALE_SELLER_ENABLED === "true";

/** Campo de vendedor visível no formulário de venda? Exige `npm run build`. */
export function isSaleSellerUiEnabled(): boolean {
  return SALE_SELLER_UI_ENABLED;
}

/**
 * Sentinela do seletor para "sem vendedor".
 *
 * Radix Select não aceita `value=""`. Um só lugar para a sentinela evita que a
 * tela mande a palavra literal ao backend e ela vire um id de usuário
 * inexistente gravado na venda.
 */
export const NO_SELLER = "__none__";

/** Valor do seletor → o que vai no corpo da requisição. */
export function sellerSelectValueToId(value: string): string | null {
  return value === NO_SELLER || !value ? null : value;
}

/**
 * Fronteira de tipo: o body é `any`, e `sellerUserId` acaba numa coluna de onde
 * sai relatório de comissão.
 *
 * `undefined` (chave ausente) devolve `undefined` — que significa "não
 * informado, não mexa", diferente de `null`, que é "limpar o vendedor". Essa
 * distinção é o que impede um PUT de formulário sem o campo de apagar o
 * vendedor de uma venda antiga.
 */
export function normalizeSellerId(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): string | null | undefined {
  if (!isSaleSellerEnabled(env)) return undefined;
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const limpo = value.trim();
  if (!limpo) return null;
  // Mesmo alfabeto de um id (cuid e afins), com teto. Nada que atravesse
  // caminho ou vire predicado inesperado.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(limpo)) return undefined;
  return limpo;
}

export interface SellerOption {
  id: string;
  name?: string | null;
  email?: string | null;
}

/**
 * Como o vendedor aparece na tela.
 *
 * Nome quando existe; e-mail como recurso — um colaborador recém-convidado
 * pode ainda não ter nome, e mostrar vazio faria a lista parecer quebrada.
 */
export function sellerLabel(s: SellerOption | null | undefined): string {
  if (!s) return "—";
  const nome = s.name?.trim();
  if (nome) return nome;
  const email = s.email?.trim();
  if (email) return email;
  return "—";
}
