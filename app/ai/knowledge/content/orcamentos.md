# Orçamentos e funil de vendas

Orçamento é uma **proposta ao cliente**: a lista de peças com preço, antes de virar venda. Ele existe em dois lugares, que são a mesma coisa vista de ângulos diferentes:

- **Financeiro → aba Orçamentos** — a lista, para criar e editar.
- **Clientes → funil (kanban)** — o acompanhamento comercial, para arrastar entre etapas.

Também aparece um painel de orçamentos aguardando conversão no PDV Balcão.

## Orçamento não é dinheiro

**Orçamento não entra no Financeiro.** Não conta em "a receber", não conta em faturamento, não aparece em nenhum indicador de caixa. É proposta — só vira dinheiro quando convertido em venda.

Isso é deliberado: contar proposta como receita inflaria todo o relatório da loja.

## Criar um orçamento

Botão de novo orçamento. Três etapas:

1. **Cliente** — quem vai receber a proposta.
2. **Itens** — as peças, com quantidade e preço. Aceita **item manual** (texto livre), igual à venda de balcão.
3. **Condições** — observações, validade e vendedor.

**Vendedor** é opcional e pode ser o administrador ou qualquer colaborador. É por ele que sai a estatística de orçamentos por vendedor (base de comissão).

**Validade** define quando o orçamento expira.

## Situação do orçamento

| Situação   | O que é             |
| ---------- | ------------------- |
| Aberto     | em andamento        |
| Convertido | virou venda         |
| Expirado   | passou da validade  |
| Cancelado  | encerrado sem venda |

**Expirado é derivado da validade**, calculado na hora em que a tela carrega — igual ao "vencida" das contas. Não é um estado que alguém marca.

## O funil (kanban)

Na tela de Clientes, os orçamentos aparecem em seis colunas:

1. **Novo**
2. **Em negociação**
3. **Proposta enviada**
4. **Fechado / ganho**
5. **Perdido / desistiu**
6. **Cancelado**

As três primeiras são as colunas **abertas** — é de lá que dá para arrastar o card para outra etapa. Orçamento já convertido, expirado ou cancelado não se move mais.

Ao mover para **Perdido**, dá para registrar o motivo.

Orçamentos antigos, criados antes do funil existir, aparecem em **Novo**.

O funil é a visão comercial: mover um card **não** converte, não cancela e não cria conta nenhuma. Quem governa isso é a situação do orçamento, não a coluna.

## Converter em venda

Converter transforma o orçamento em uma **Conta a Receber com itens** — exatamente uma venda de balcão. Os itens são copiados um a um, com o preço que estava no orçamento.

A partir daí valem as regras da venda: receber baixa o estoque, fiado fica pendente, estorno devolve as peças.

Um orçamento converte em **no máximo uma venda**. Apagar o orçamento depois **não apaga a venda já convertida**.

## Erros comuns

- **"Meu orçamento não aparece no financeiro"** — correto: orçamento não é conta. Só depois de converter.
- **Não consigo arrastar o card** — o orçamento já está convertido, expirado ou cancelado. Só as três primeiras colunas movem.
- **Orçamento expirou sozinho** — passou da validade. É derivado da data.
- **Estoque não baixou ao converter** — a conversão cria a venda, ela ainda precisa ser recebida.

## Limitações conhecidas

- Não há envio de orçamento por e-mail nem por WhatsApp direto da tela.
- Não há histórico de versões da proposta: editar sobrescreve.
- Não há aprovação do cliente dentro do sistema.

> ⚠️ PENDENTE DE CONFIRMAÇÃO: como o cliente hoje entrega o orçamento ao comprador (imprime, tira print, manda PDF). Isso muda o que faz sentido eu sugerir quando alguém perguntar "como envio o orçamento".
