# Estoque e localizações

Estoque no Dexo é a **quantidade** de cada peça. Localização é **onde ela está** no galpão. São coisas separadas: a peça pode ter estoque 3 e nenhuma localização, ou estar em uma prateleira com estoque 0.

## Quem mexe no estoque

O estoque muda por estes caminhos, e só por eles:

| O que aconteceu                       | Efeito no estoque              |
| ------------------------------------- | ------------------------------ |
| Pedido de marketplace importado       | baixa                          |
| Venda de balcão **marcada como paga** | baixa                          |
| Pedido cancelado no marketplace       | devolve                        |
| Estorno de venda de balcão            | devolve                        |
| Edição manual do produto              | o valor digitado passa a valer |

Venda de balcão **fiado** ou deixada pendente **não baixa estoque** — a baixa acontece quando alguém marca a conta como paga. É o comportamento correto: enquanto a conta está pendente, é a peça que ainda pode voltar.

Toda alteração fica registrada com estoque anterior, novo e o motivo.

Quando o estoque de uma peça chega a zero por uma venda de balcão, o Dexo **pausa os anúncios daquela peça** nos marketplaces, para não vender o que já saiu.

## Localizações

A tela fica em **Principal → Localizações**. Cada localização tem:

- **Código** (a sigla, até 20 caracteres) — `PRT-01`, `GAV-A3`, `EST-12`. Único por loja.
- **Descrição** (opcional, até 200 caracteres).
- **Capacidade máxima** — quantas peças cabem. `0` significa sem limite.

Localizações formam **hierarquia**: uma prateleira pode estar dentro de uma estante, que está dentro de um corredor. A tela mostra em árvore.

Quando há capacidade definida, a tela mostra o quanto está ocupado (`14/20`) e sinaliza a localização **cheia**.

## Criar muitas localizações de uma vez

Em vez de cadastrar `PRT-01` até `PRT-40` na mão, use a criação **em massa por faixa**. Cada faixa tem:

- **Prefixo** — `PRT-`
- **De / Até** — `1` a `40`
- **Zeros à esquerda** — `2` gera `PRT-01`, `PRT-02`… em vez de `PRT-1`, `PRT-2`
- **Capacidade** e **descrição** aplicadas a toda a faixa
- **Localização pai** (opcional)

O diálogo mostra uma prévia dos primeiros códigos e do último antes de criar.

Os limites são: **200 localizações por faixa**, **500 no lote inteiro** e **20 faixas por lote**. Códigos repetidos dentro do mesmo lote são apontados antes de gravar.

## Colocar uma peça em uma localização

Três caminhos:

1. **No cadastro/edição do produto** — no passo Preços e Estoque há o campo de localização, com busca.
2. **Pelo QR da localização** — no formulário do produto há um botão de leitura; escanear a etiqueta da prateleira preenche o campo.
3. **Pela tela Receber por scan** — é o caminho de volume, para guardar várias peças em uma prateleira de uma vez. Está descrito no documento de etiquetas e scan.

Além do vínculo com a localização cadastrada, o produto tem um campo de **localização em texto livre** ("Prateleira A1, Gaveta 3"), que é o que aparece quando a loja ainda não cadastrou a árvore de localizações.

## Etiquetas de localização

Na tela Localizações dá para gerar o **PDF das etiquetas** das prateleiras selecionadas. Cada etiqueta traz o código e um QR — é esse QR que a tela de Receber por scan lê.

## Erros comuns

- **"Deve ser um número não negativo"** na capacidade — capacidade aceita 0 (sem limite) ou positivo.
- **Código de localização repetido** — o código é único por loja; a criação em massa aponta a repetição antes de gravar.
- **Localização aparece cheia mas ainda cabe peça** — a capacidade é um aviso da loja, não uma trava: o sistema deixa guardar mesmo assim.
- **Estoque não bateu depois de uma venda de balcão** — conferir se a conta foi mesmo marcada como paga. Conta pendente ou fiado não baixa.

## Limitações conhecidas

- A capacidade máxima é informativa: excedê-la avisa, mas não impede.
- Não existe inventário cíclico nem contagem programada no sistema.
- Uma peça está em uma localização por vez.

> ⚠️ PENDENTE DE CONFIRMAÇÃO: o que deve acontecer quando o usuário exclui uma localização que ainda tem peças dentro — se as peças ficam sem localização ou se a exclusão é bloqueada. Não confirmei o comportamento na tela.
