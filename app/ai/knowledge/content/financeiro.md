# Financeiro

A tela **Financeiro** (menu Principal → Financeiro) controla o que a loja tem a receber e a pagar. Tem três abas: **Contas a Receber**, **Contas a Pagar** e **Orçamentos**.

No topo, quatro indicadores: **A receber (pendente)**, **A receber (vencido)**, **A pagar (pendente)** e **A pagar (vencido)**.

## Status de uma conta

| Status    | O que significa                           |
| --------- | ----------------------------------------- |
| Pendente  | ainda não foi paga e não venceu           |
| Vencida   | passou do vencimento e continua em aberto |
| Paga      | quitada                                   |
| Cancelada | anulada                                   |

**Vencida não é um estado gravado**: é calculado toda vez que a tela carrega, comparando o vencimento com a data de hoje. Uma conta pendente vira vencida sozinha, na virada do dia, sem ninguém mexer.

## Criar uma conta

Botão de nova conta na aba desejada. O passo a passo tem 4 etapas:

1. **Cliente** — quem está envolvido. Dá para escolher no cadastro ou criar na hora.
2. **Título** — documento, motivo, detalhes, forma de pagamento, valor total, unidade e — nas contas a receber — os itens da venda.
3. **Encargos** — Multa (valor fixo), Multa (%), Juros ao mês (%) e Tolerância (dias).
4. **Parcelamento** — vencimento, número de parcelas e periodicidade.

Toda conta precisa de um cliente. Isso vale também para **Contas a Pagar** — o fornecedor é cadastrado como cliente.

## Contas com itens = venda de balcão

Quando a conta a receber tem **itens**, ela é uma venda de balcão. Isso muda o comportamento:

- Marcar como paga **baixa o estoque** das peças.
- Estornar devolve as peças.
- Anúncios de peças que zeraram são pausados.

Conta sem itens (um aluguel, uma mensalidade, uma dívida) não toca em estoque nenhum.

A venda de balcão pode ser feita tanto por aqui quanto pela tela do PDV Balcão — é o mesmo registro, vistas diferentes.

## Formas de pagamento

PIX, Cartão de Crédito, Cartão de Débito, Boleto, Dinheiro, Transferência/TED e **Fiado**.

**Fiado só existe em Contas a Receber.** Não aparece em Contas a Pagar porque não é pagamento efetivado — é venda a prazo.

Uma venda aceita várias formas ao mesmo tempo; a coluna "Forma" mostra a predominante (a de maior valor) e o detalhe fica dentro da conta.

## Encargos

- **Multa** — em valor fixo ou em percentual.
- **Juros ao mês (%)** — sobre o atraso.
- **Tolerância (dias)** — dias de atraso sem encargo.

São informativos por conta; não existe um cálculo automático de encargo consolidado por período.

## Parcelamento e entrada

Uma venda pode ser dividida em **entrada + parcelas**. A entrada carrega os itens; cada parcela é uma cobrança independente, com vencimento e baixa próprios, e vence sozinha na data dela.

Entrada + parcelas somam exatamente o total: nenhum valor é contado duas vezes nos indicadores.

## Unidades (filiais)

Contas podem ser atribuídas a uma **Unidade** (filial ou loja física), o que permite separar o financeiro por ponto. Unidade é opcional — "Sem unidade" é um estado válido.

Unidade não se apaga, se **inativa**: o histórico das contas que a usaram continua íntegro.

## Relatório

Há um botão de relatório com os períodos **Hoje**, **Últimos 7 dias**, **Últimos 30 dias**, **Este mês** e **Personalizado** (data inicial e final).

## Estorno

Estornar uma conta paga com itens desfaz a venda: devolve as peças ao estoque e reverte o recebimento. É o caminho para venda cancelada — não apagar a conta.

Contas **entrada + parcelas** não podem ser apagadas pela entrada: apagar a entrada faria sumir parcelas que o cliente ainda deve. O sistema bloqueia e manda estornar.

## Erros comuns

- **Conta vencida que já foi paga** — verificar se o pagamento foi mesmo registrado; "vencida" é derivado do vencimento e só sai quando a conta é marcada como paga.
- **Estoque não baixou na venda** — a conta está pendente. A baixa é no recebimento.
- **Fiado não aparece na lista de formas** — está em Contas a Pagar, onde fiado não existe.
- **Não consigo apagar a conta** — é a entrada de uma venda parcelada. O caminho é estornar.
- **Números do Financeiro diferentes do Dashboard** — o Financeiro trata canceladas de um jeito e o Dashboard de outro; ao comparar, conferir se ambos estão com o mesmo filtro de status e o mesmo período.

## Limitações conhecidas

- Não há conciliação bancária nem importação de extrato.
- Não há cálculo automático de multa/juros na baixa: os campos são registro.
- Não há fluxo de caixa projetado.
- Contas a Pagar não têm itens: não movimentam estoque.
