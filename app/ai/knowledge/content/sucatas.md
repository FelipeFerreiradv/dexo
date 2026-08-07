# Sucatas e desmembramento

Sucata é o **veículo arrematado** que vai virar peça. A tela fica em **Principal → Sucatas** e tem três abas: **Pipeline**, **Lista** e **Balcão**.

O objetivo do módulo é responder duas perguntas: onde cada veículo está no fluxo do pátio, e quanto de dinheiro já voltou de cada um.

## Cadastrar uma sucata

Botão de nova sucata. Quatro abas:

1. **Veículo** — marca, modelo, apelido, ano, versão, cor, placa, chassi, número do motor, Renavam, lote, certificado de baixa, localização no pátio.
2. **Financeiro** — custo de arremate, custos extras (guincho, transporte, taxas) e forma de pagamento.
3. **Dados Fiscais** — NCM, CNPJ do fornecedor, chave de acesso, número/série da nota, protocolo, natureza da operação, ICMS, modalidade de frete.
4. **Imagens** — fotos do veículo.

O **apelido** ("Gol bola azul") é o que a equipe usa no galpão para identificar o carro sem decorar placa.

**Investimento = custo de arremate + custos extras.** É esse número que serve de base para o retorno.

## Duas situações ao mesmo tempo

Uma sucata tem **dois estados independentes**, e confundi-los é a dúvida mais comum do módulo.

**Onde o veículo está (fluxo do pátio):**

| Estágio     | O que é                       |
| ----------- | ----------------------------- |
| Em Trânsito | arrematado, a caminho da loja |
| No Pátio    | chegou, veículo inteiro       |
| No Elevador | em desmontagem                |
| Desmembrado | concluído, peças cadastradas  |

O padrão de uma sucata nova é **No Pátio**. Cada mudança de estágio fica registrada com data, o que permite medir quanto tempo o veículo passou em cada fase.

**Situação do estoque dela:**

| Situação   | Como o sistema decide                                  |
| ---------- | ------------------------------------------------------ |
| Disponível | nenhuma venda atribuída ao lote                        |
| Em uso     | já teve venda, mas ainda há peça em estoque            |
| Esgotada   | todas as peças cadastradas do lote estão com estoque 0 |
| Arquivada  | encerrada manualmente                                  |

A situação do estoque é **recalculada sozinha** conforme as peças vão sendo vendidas. Um lote que só teve venda de peça avulsa (item manual, sem produto cadastrado) nunca vira "Esgotada" — sem peça cadastrada, não há o que esgotar.

Os dois estados são ortogonais: um veículo pode estar **No Pátio** e **Disponível**, ou **Desmembrado** e **Em uso**.

## Vincular peças ao lote

No cadastro do produto, no passo de Preços e Estoque, há o campo para vincular a peça a uma sucata. É esse vínculo que faz a peça contar no retorno do lote.

Na venda de balcão também é possível apontar a sucata de origem direto no item — inclusive em item manual, que não tem produto cadastrado. Esse apontamento explícito tem precedência sobre o vínculo do produto.

## Retorno do lote

Abrindo uma sucata, além dos dados do veículo, aparecem:

- o **investimento** (arremate + extras);
- o **quanto já voltou** em vendas atribuídas ao lote;
- o **retorno** sobre o investimento;
- a lista de peças do lote e quantas já saíram;
- um indicador visual do progresso da desmontagem, preenchido conforme o percentual de peças vendidas.

## Aba Balcão

Mostra as vendas de balcão atribuídas às sucatas — é onde se vê o dinheiro que entrou por lote sem passar por marketplace.

## Erros comuns

- **Sucata não aparece como Esgotada** — só esgota quando **todas** as peças cadastradas do lote estão com estoque 0. Lote com venda só de peça avulsa fica em "Em uso" de propósito.
- **Venda não apareceu no retorno do lote** — a peça vendida não estava vinculada à sucata, ou o item da venda não apontava o lote.
- **Confusão entre estágio e situação** — "No Pátio" é onde o carro está; "Disponível" é se ainda tem peça para vender. Não são a mesma coluna.
- **O retorno parece baixo** — venda de balcão pendente ainda não conta como recebida.

## Limitações conhecidas

- Não há checklist de peças esperadas por modelo de veículo: o que existe no lote é o que foi cadastrado.
- O custo do lote não é rateado automaticamente entre as peças; não há custo unitário derivado do arremate.
- Não há controle de documentação/baixa do veículo além dos campos de registro.

> ⚠️ PENDENTE DE CONFIRMAÇÃO: se a mudança de estágio do pátio é feita arrastando o card no Pipeline, por um menu no card, ou pelos dois. Não confirmei a interação, e é exatamente o que alguém vai me perguntar.
