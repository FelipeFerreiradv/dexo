// BLOCO E — editar a venda no PDV, antes da baixa.
//
// Hoje o livro do dia manda o operador para o Financeiro (o próprio texto do
// card diz isso). Uma venda recém-lançada com o item errado obriga a trocar de
// tela, achar a linha de novo e só então corrigir — enquanto o cliente espera
// no balcão.
//
// A EDIÇÃO SÓ EXISTE ANTES DO RECEBIMENTO, e isso não é conservadorismo: o
// estoque só se move em `markPaid` e `reverse`. Depois da baixa, mexer nos
// itens desencontra a venda do que saiu da prateleira — e é exatamente o que a
// guarda de backend (`sale-edit-guard.ts`) passa a recusar. Aqui a tela apenas
// não oferece o caminho que o servidor recusaria.
//
// Nada de endpoint novo: reusa o `GET /finance/receivables/:id` e os mesmos
// montadores de formulário do Financeiro (`row-to-form.ts`), para que as duas
// telas editem pelo MESMO caminho. Uma segunda montagem seria uma segunda
// chance de esquecer um campo — foi assim que a Fase 1.0 zerou encargos.

import { getApiBaseUrl } from "@/lib/api";
import {
  entryPaymentsToForm,
  financeRowToFormSeed,
  type FinanceFormSeed,
} from "@/app/financeiro/lib/row-to-form";

/** Status em que a venda ainda pode ser corrigida pelo caixa. */
export type EditableSaleStatus = "PENDENTE" | "VENCIDA";

/**
 * A venda pode ser editada pelo PDV?
 *
 * PAGA não: o estoque já saiu. CANCELADA não: não há o que corrigir numa venda
 * desfeita, e reabri-la para edição só criaria um registro híbrido.
 *
 * Função separada e pura porque a MESMA regra precisa valer no botão e em
 * qualquer lugar que venha a oferecer o atalho.
 */
export function canEditSaleInPdv(status: string | null | undefined): boolean {
  return status === "PENDENTE" || status === "VENCIDA";
}

/**
 * Carrega a venda e devolve o `initialData` do FinanceDialog.
 *
 * `null` quando a venda sumiu (404) — quem chama avisa em vez de abrir um
 * formulário vazio que, ao salvar, criaria uma venda nova.
 */
export async function fetchSaleForEdit(
  receivableId: string,
  email: string,
  signal?: AbortSignal,
): Promise<FinanceFormSeed | null> {
  const res = await fetch(
    `${getApiBaseUrl()}/finance/receivables/${receivableId}`,
    { headers: { email }, signal },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Erro ao carregar a venda");
  const data = await res.json();
  const entry = data?.entry;
  if (!entry?.id) return null;

  const seed = financeRowToFormSeed(entry);

  // Contrato: `findById` de receivable SEMPRE inclui `items` (array, mesmo
  // vazio). Vindo diferente, NÃO abrimos o formulário: o submit manda a lista
  // inteira, então abrir sem itens e salvar APAGARIA os que existem — é a
  // mesma trava que o Financeiro aplica.
  if (!Array.isArray(entry.items)) {
    throw new Error("Resposta sem itens");
  }
  seed.items = entry.items.map((it: any) => ({
    productId: it.productId ?? null,
    description: it.description ?? null,
    scrapId: it.scrapId ?? null,
    listingId: it.listingId ?? null,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    // Alimenta o seed do productMeta no dialog (SKU/nome).
    product: it.product ?? null,
  }));

  // As linhas de pagamento viajam no mesmo GET. Sem lê-las, o bloco de
  // pagamento combinado reabriria vazio e a venda pareceria ter perdido as
  // formas — o defeito que a CORREÇÃO 2 consertou no Financeiro.
  const pagamentos = entryPaymentsToForm(entry.payments);
  if (pagamentos) seed.payments = pagamentos;

  return seed;
}
