# PDV Balcão

O **PDV Balcão** (menu Principal → Financeiro → PDV Balcão) é a tela de venda presencial: o cliente chega no balcão, escolhe a peça, paga e leva. Muita gente escreve "PVD" — é a mesma coisa.

Por baixo, cada venda de balcão é uma **Conta a Receber com itens** no Financeiro. Quem prefere trabalhar pelo Financeiro faz a mesma venda por lá; o PDV é a tela desenhada para o balcão, com o caixa do dia à vista.

O módulo depende de estar habilitado para a loja.

## O que a tela mostra

Quatro indicadores no topo:

- **Caixa de hoje** — o quanto entrou, com a divisão por forma de pagamento.
- **Vendas hoje** — quantidade e ticket médio.
- **A receber (balcão)** — vendas pendentes acumuladas.
- **Vencidas (balcão)** — quanto e quantas vendas passaram do vencimento.

Abaixo, o **livro do dia** com as vendas recentes e um painel de orçamentos aguardando conversão.

## Fazer uma venda

Botão de nova venda. O fluxo pede:

1. **Cliente** — busca no cadastro ou cria na hora.
2. **Itens** — busca a peça pelo nome ou SKU e informa quantidade e preço. O preço vem do produto e é editável na venda.
3. **Pagamento** — a forma (ou as formas) e o vencimento.

Os itens aceitam **peça avulsa**: um item digitado à mão, sem produto cadastrado. Serve para o parafuso, a mão de obra, o item que ninguém vai cadastrar. Na linha do item manual há a opção de **criar no catálogo**, que transforma aquilo em produto de verdade no momento em que a venda é recebida.

## Receber agora

Existe um interruptor **Receber agora**, ligado por padrão. Com ele ligado, a venda já nasce recebida — e é o recebimento que **baixa o estoque**.

Duas situações fogem disso:

- **Fiado sempre fica pendente**, mesmo com o interruptor ligado. Venda a prazo é, por definição, dinheiro que ainda não entrou.
- Desligando o interruptor, a venda fica pendente e a baixa acontece quando alguém marcar a conta como paga.

Isso vale também para pagamento combinado: **basta uma parte em fiado** para a venda ficar pendente. Marcar como paga uma venda com saldo em aberto baixaria estoque de dinheiro que não entrou.

## Formas de pagamento

PIX, Cartão de Crédito, Cartão de Débito, Boleto, Dinheiro, Transferência/TED e **Fiado**.

Fiado só existe em contas **a receber** — nunca aparece em contas a pagar, porque não é pagamento efetivado, é venda a prazo.

A mesma venda aceita **mais de uma forma**: metade no PIX, metade em dinheiro. A soma das formas tem que fechar com o total da venda, conferida em centavos.

Quando há várias formas, a coluna "Forma" mostra a **predominante** (a de maior valor); o detalhe fica dentro da venda.

## Entrada mais parcelas

A venda pode ser dividida em **entrada + N parcelas**. A entrada carrega os itens; cada parcela vira uma cobrança própria, com vencimento próprio, que pode ser baixada individualmente e vence sozinha.

Entrada + parcelas somam exatamente o total da venda — nenhum valor é contado duas vezes.

## O que dá para fazer depois da venda

No menu de ações da venda:

- **Recibo simples** — abre para impressão.
- **Emitir NFC-e** — quando o módulo fiscal está habilitado. Só depois de receber a venda.
- **Reimprimir / Consultar NFC-e** quando já foi emitida; **Reemitir**, se foi rejeitada.
- **Gerar NF-e (modelo 55)** — o caminho para quando a NFC-e não serve.
- **Cancelar venda** — estorna. Só vale para venda já recebida; venda cancelada não pode ser cancelada de novo.

O estorno devolve as peças ao estoque.

**Venda acima de R$ 10.000 não emite NFC-e** — a legislação exige NF-e (modelo 55) e o sistema avisa isso na própria ação.

## Erros comuns

- **"Receba a venda antes de emitir a NFC-e"** — a venda ainda está pendente.
- **"Venda acima de R$ 10.000 — use NF-e (modelo 55)"** — limite legal da NFC-e.
- **"Só vendas já recebidas podem ser estornadas"** — venda pendente se apaga/edita, não se estorna.
- **Estoque não baixou** — a venda ficou pendente (fiado ou interruptor desligado). Marcar como paga resolve.
- **A soma dos pagamentos não fecha** — as formas informadas têm que somar o total exato da venda.
- **O menu PDV Balcão não aparece** — o módulo não está habilitado para a loja, ou o colaborador não tem a permissão.

## Limitações conhecidas

- Não há gaveta de dinheiro, TEF nem integração com maquininha: a forma de pagamento é registro, não cobrança.
- Não há controle de abertura/fechamento de caixa por operador; o "Caixa de hoje" é a soma do dia.
- Orçamento não entra no financeiro até ser convertido em venda.
