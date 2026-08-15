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
 * Quais campos do payload são recusados, dado o status atual da conta.
 *
 * Só PAGA bloqueia. PENDENTE e VENCIDA continuam totalmente editáveis — é
 * literalmente o "antes da baixa" do bloco. CANCELADA também não bloqueia:
 * ali o estoque já voltou, e travar a edição de uma venda cancelada não
 * protegeria nada (e impediria corrigir o registro depois do estorno).
 */
export function blockedFieldsOnPaidSale(
  data: Record<string, unknown> | null | undefined,
  status: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!isSaleEditGuardEnabled(env)) return [];
  if (status !== "PAGA") return [];
  if (!data) return [];
  return PROTECTED_WHEN_PAID.filter((f) => f in data);
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
