# Pedidos dos marketplaces

A tela **Pedidos** (menu Principal → Pedidos) reúne as vendas que vieram do Mercado Livre, da Shopee e do Magalu num lugar só. Venda de balcão **não** aparece aqui — ela vive no Financeiro e no PDV.

O pedido chega sozinho: o Dexo importa dos marketplaces e, ao importar, baixa o estoque das peças vendidas e pausa os anúncios das que zeraram.

## Como o pedido chega

O Mercado Livre avisa o Dexo quando há venda. A Shopee não avisa — o sistema vai buscar em ciclos. Por isso pedido da Shopee pode demorar um pouco mais que pedido do Mercado Livre para aparecer.

Junto com o pedido vêm o cliente e os itens. Se o comprador ainda não existe no cadastro de Clientes, ele é criado automaticamente.

**A data que o Dexo usa é a data da venda no marketplace**, não a data em que importou. É o que faz o faturamento cair no mês certo mesmo quando a importação atrasa.

## Filtrar e buscar

A tela tem busca por texto e filtros de **Status**, **Marketplace**, **Data inicial / final** e **Preço mínimo / máximo**.

Os status possíveis são: **Pendente**, **Pago**, **Enviado**, **Entregue** e **Cancelado**. Eles refletem o que o marketplace informa.

## O que dá para fazer em um pedido

Abrindo o pedido, além dos dados da venda e dos itens:

- **Emitir NF-e** — leva ao assistente de nota fiscal já com os dados do pedido preenchidos.
- **Emitir etiqueta** de envio e **Baixar** o PDF dela. Uma etiqueta já gerada é reaproveitada, não duplicada.

O botão de etiqueta depende de a funcionalidade estar habilitada para a loja.

## Pendências de importação

Quando o marketplace devolve uma venda que o Dexo **não conseguiu** transformar em pedido, ela não some em silêncio: aparece um aviso amarelo no topo da tela de Pedidos —

> "N vendas não viraram pedido automaticamente — o estoque dessas vendas ainda não foi baixado."

Em **Ver detalhes** dá para ver o motivo de cada uma e **tentar de novo**.

A causa mais comum é o item vendido não casar com nenhum produto do catálogo: o SKU do anúncio não bate com o SKU de nenhuma peça cadastrada. Cadastrar/corrigir a peça e mandar tentar de novo resolve.

Enquanto a pendência estiver aberta, **o estoque daquela venda não foi baixado** — a peça continua aparecendo como disponível nos outros canais. É a pendência que mais importa resolver rápido.

## Cancelamento e estorno

Pedido cancelado no marketplace devolve as peças ao estoque, e o anúncio volta a ficar disponível.

O Magalu tem um estado de "indisponível" que **não** é cancelamento e **não** estorna estoque — é o comportamento correto, porque a venda ainda pode se concretizar.

## Erros comuns

- **Venda não apareceu** — se for da Shopee, pode ser só o ciclo de busca. Se já passou tempo demais, conferir o aviso de pendências de importação.
- **"venda não virou pedido automaticamente"** — item sem produto correspondente no catálogo. Ver o detalhe da pendência.
- **Estoque não bateu** — quase sempre é pendência de importação em aberto, ou venda de balcão ainda não recebida (o balcão só baixa estoque quando a conta é marcada como paga).
- **Etiqueta não gera** — a maioria dos casos é o marketplace exigir a nota fiscal enviada antes de liberar a etiqueta.

## Limitações conhecidas

- Pedido de marketplace não é editável no Dexo: o que vale é o que o marketplace informou.
- Venda de balcão não aparece nesta tela.
- O total de faturamento exibido aqui inclui pedidos cancelados; quem precisa do número sem cancelados usa o filtro de status.

> ⚠️ PENDENTE DE CONFIRMAÇÃO: quais marketplaces, hoje, exigem NF-e enviada antes de liberar a etiqueta de envio para o cliente dele. Cada canal tem regra própria e ela muda; não quero afirmar por qual deles isso vale sem você confirmar.
