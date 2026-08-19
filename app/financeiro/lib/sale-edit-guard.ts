// BLOCO E — o que ainda pode ser editado depois que a venda foi recebida.
//
// O PROBLEMA QUE ISTO FECHA
// O `PUT /finance/receivables/:id` nunca leu o status. Editar uma venda JÁ
// PAGA passava por ele sem nenhuma guarda, e o estrago não é só um número
// errado numa tela:
//
//  1. ESTOQUE. O estoque só se move em `markPaid` e `reverse`. Trocar a
//     quantidade de 2 para 5 grava 5 e não baixa as 3; remover o item apaga a
//     linha e não devolve a baixa.
//  2. O ESTORNO FICA ENVENENADO. `reverse` restaura pelos itens ATUAIS
//     (finance.usecase.ts:1018), enquanto `markPaid` baixou os do momento do
//     pagamento. Baixou 2, estorna 5 ⇒ +3 peças que não existem.
//  3. A MARCA DA PEÇA AVULSA SE PERDE. O replace recriava as linhas sem
//     `autoCreatedProduct`, e é ele que dispara a compensação simétrica do
//     estorno — sem ele sobra um produto fantasma com estoque positivo de uma
//     peça que já saiu da loja.
//  4. O CAIXA É REESCRITO. `totalAmount` alimenta o `paidAmount` do resumo,
//     sem lançamento de contrapartida.
//
// A ASSIMETRIA QUE PROVA SER BURACO, E NÃO DECISÃO
// O `DELETE` já recusa conta paga com itens: "Use Estornar para devolver o
// estoque" (finance.usecase.ts:937), mapeado para 409. O `PUT` com `items: []`
// apaga exatamente as mesmas linhas — sem guarda e sem confirmação. A casa já
// tinha decidido; o PUT só não foi coberto.
//
// O QUE CONTINUA EDITÁVEL: documento, motivo, detalhes, cliente, unidade,
// vencimento, encargos, forma predominante e vendedor. Nada disso mexe em
// estoque nem no valor recebido, e corrigir o número de um documento não pode
// exigir estornar a venda inteira.
//
// Módulo PURO (sem I/O): a decisão é uma tabela, e tabela se testa.

// `payment-methods` também é módulo puro e sem imports — seguro dos dois lados
// da fronteira (Fastify e bundle do Next). Reusar o arredondamento importa:
// duas conversões para centavos que discordem viram bloqueio intermitente.
import { toCents } from "@/app/lib/payment-methods";

/**
 * Campos que deixam de ser editáveis depois da baixa.
 *
 * `installmentPlan` entra junto porque recria as parcelas — em venda já
 * recebida isso reescreveria a cobrança que gerou o dinheiro que entrou.
 */
export const PROTECTED_WHEN_PAID = [
  "items",
  "totalAmount",
  "payments",
  "installmentPlan",
] as const;

export type ProtectedWhenPaidField = (typeof PROTECTED_WHEN_PAID)[number];

/** Rótulos para a mensagem — o operador não conhece o nome do campo. */
const ROTULOS: Record<string, string> = Object.assign(Object.create(null), {
  items: "itens",
  totalAmount: "valor total",
  payments: "formas de pagamento",
  installmentPlan: "parcelamento",
});

/**
 * Flag de BACKEND. Ausente ⇒ `blockedFieldsOnPaidSale` devolve `[]` e o PUT se
 * comporta exatamente como hoje.
 *
 * A guarda é uma RESTRIÇÃO — o único ponto deste projeto em que algo deixa de
 * ser possível. Por isso ela nasce desligada e liga com `pm2 restart`: se
 * algum fluxo legítimo depender de editar venda paga, desliga na hora, sem
 * redeploy.
 */
export function isSaleEditGuardEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SALE_EDIT_GUARD_ENABLED === "1";
}

/**
 * O payload traz algum campo que a guarda vigia? Serve para decidir se vale a
 * pena LER a conta — sem campo protegido no corpo, nenhuma consulta extra
 * acontece e o caminho fica idêntico ao de hoje.
 */
export function touchesProtectedFields(
  data: Record<string, unknown> | null | undefined,
): boolean {
  if (!data) return false;
  return PROTECTED_WHEN_PAID.some((f) => f in data);
}

/**
 * Estado ANTERIOR da venda, no recorte que a comparação precisa.
 *
 * É de propósito um subconjunto estrutural do `FinanceEntry` devolvido pelo
 * repositório: o módulo continua puro e testável sem arrastar o tipo inteiro.
 */
export interface SaleStateForGuard {
  totalAmount?: number | string | null;
  items?: unknown[] | null;
  payments?: unknown[] | null;
}

/** Reais → centavos inteiros. Comparar dinheiro em float é como o `0.1+0.2`. */
const cents = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? toCents(n) : null;
};

/**
 * O total mudou de verdade?
 *
 * `100` (number) e `"100.00"` (o que o Prisma devolve para Decimal) são o
 * MESMO dinheiro — comparar cru diria que mudou em todo save.
 */
export function mesmoTotal(depois: unknown, antes: unknown): boolean {
  const a = cents(antes);
  const d = cents(depois);
  if (a === null || d === null) return false; // não dá para afirmar: bloqueia
  return a === d;
}

/**
 * Assinatura de uma linha de item, no que ela tem de ECONÔMICO.
 *
 * `id`, `createdAt`, `product` e `autoCreatedProduct` ficam de fora porque o
 * formulário não os envia — incluí-los faria toda edição parecer alteração, e
 * o bug atual só trocaria de causa.
 *
 * `scrapId` e `listingId` ENTRAM. As duas telas que editam venda os repõem
 * (o Financeiro em `finance-list.tsx:302-313`, o PDV em `pdv-edit-sale.ts`),
 * então incluí-los não custa nenhum 409 falso — e sem eles seria possível
 * trocar de qual sucata a peça saiu numa venda já recebida, o que remaneja
 * contagem de lote sem passar por estorno.
 */
function chaveItem(it: unknown): string | null {
  if (!it || typeof it !== "object") return null;
  const o = it as Record<string, unknown>;
  const q = Number(o.quantity);
  const p = cents(o.unitPrice);
  if (!Number.isFinite(q) || p === null) return null;
  const id = o.productId
    ? `p:${String(o.productId)}`
    : `d:${String(o.description ?? "").trim()}`;
  const sucata = o.scrapId ? String(o.scrapId) : "";
  const anuncio = o.listingId ? String(o.listingId) : "";
  return `${id}|${q}|${p}|${sucata}|${anuncio}`;
}

/** Idem para pagamento: a forma e o valor são o que move dinheiro. */
function chavePagamento(pg: unknown): string | null {
  if (!pg || typeof pg !== "object") return null;
  const o = pg as Record<string, unknown>;
  const v = cents(o.amount);
  if (!o.method || v === null) return null;
  return `${String(o.method)}|${v}`;
}

/**
 * Duas listas contêm o mesmo conjunto de linhas?
 *
 * MULTISET, não sequência: reordenar as linhas na tela não muda nem o estoque
 * nem o dinheiro, e acusar isso seria o bloqueio universal de novo. Qualquer
 * linha que não dê para normalizar derruba a comparação para "mudou" — na
 * dúvida a guarda BLOQUEIA, que é o lado seguro do erro.
 */
function mesmoConjunto(
  depois: unknown,
  antes: unknown,
  chave: (x: unknown) => string | null,
): boolean {
  if (!Array.isArray(depois) || !Array.isArray(antes)) return false;
  if (depois.length !== antes.length) return false;
  const ka = antes.map(chave);
  const kd = depois.map(chave);
  if (ka.some((k) => k === null) || kd.some((k) => k === null)) return false;
  const a = (ka as string[]).sort();
  const d = (kd as string[]).sort();
  // Elemento a elemento, sem `join`: concatenar exigiria escolher um separador
  // que não pudesse aparecer numa descrição de item, e qualquer escolha ali é
  // uma aposta. Comparar posição a posição não tem separador para errar.
  return a.every((k, i) => k === d[i]);
}

export const mesmosItens = (d: unknown, a: unknown) =>
  mesmoConjunto(d, a, chaveItem);
export const mesmosPagamentos = (d: unknown, a: unknown) =>
  mesmoConjunto(d, a, chavePagamento);

/**
 * Quais campos do payload são recusados, dado o status atual da conta.
 *
 * Só PAGA bloqueia. PENDENTE e VENCIDA continuam totalmente editáveis — é
 * literalmente o "antes da baixa" do bloco. CANCELADA também não bloqueia:
 * ali o estoque já voltou, e travar a edição de uma venda cancelada não
 * protegeria nada (e impediria corrigir o registro depois do estorno).
 *
 * ⭐ DECIDE POR VALOR MUDADO, NÃO POR PRESENÇA DE CHAVE.
 * A primeira versão filtrava `f in data`, e isso bloqueava TUDO: `totalAmount`
 * tem default `0` no schema do formulário e o diálogo reenvia a lista de itens
 * inteira em toda edição de venda de balcão. Na prática, corrigir só o
 * documento de uma venda paga tomava 409 — enquanto a própria mensagem de erro
 * prometia que documento, cliente, vencimento e vendedor seguiam editáveis.
 * Também colidia com a decisão do bloco do vendedor ("sempre corrigível").
 *
 * `antes` ausente ⇒ mantém o comportamento por presença. É o default
 * CONSERVADOR e é contrato, não acidente: sem o estado anterior não há como
 * afirmar que nada mudou, e a guarda existe justamente para o caso em que a
 * dúvida é cara.
 */
export function blockedFieldsOnPaidSale(
  data: Record<string, unknown> | null | undefined,
  status: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  antes?: SaleStateForGuard | null,
): string[] {
  if (!isSaleEditGuardEnabled(env)) return [];
  if (status !== "PAGA") return [];
  if (!data) return [];
  return PROTECTED_WHEN_PAID.filter((f) => {
    if (!(f in data)) return false;
    if (!antes) return true;
    switch (f) {
      case "totalAmount":
        return !mesmoTotal(data.totalAmount, antes.totalAmount);
      case "items":
        return !mesmosItens(data.items, antes.items ?? []);
      case "payments":
        return !mesmosPagamentos(data.payments, antes.payments ?? []);
      // `installmentPlan` continua por PRESENÇA, e não é omissão: ele não
      // existe no estado anterior (não é coluna nem relação — é uma INSTRUÇÃO
      // de "recrie as parcelas", e o update já o descarta). Não há com o quê
      // comparar, e mandá-lo numa venda paga significa querer reescrever a
      // cobrança que gerou o dinheiro. Bloquear é de graça: a tela nunca o
      // envia em edição.
      default:
        return true;
    }
  });
}

/**
 * Mensagem do bloqueio.
 *
 * Contém "Estornar" de propósito: é a mesma palavra que o `DELETE` já usa, e
 * é por ela que o handler mapeia o erro para 409. Dizer O QUE fazer importa
 * mais que dizer que não pode — o operador precisa sair daqui sabendo que o
 * caminho existe.
 */
export function saleEditGuardMessage(campos: string[]): string {
  const nomes = campos.map((c) => ROTULOS[c] ?? c);
  const lista =
    nomes.length <= 1
      ? (nomes[0] ?? "estes campos")
      : `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
  return (
    `Venda já recebida: não é possível alterar ${lista}. ` +
    `Use Estornar para devolver o estoque e refaça a venda. ` +
    `Documento, cliente, vencimento, vendedor e encargos seguem editáveis.`
  );
}
