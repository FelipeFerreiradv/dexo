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

## Excluir uma localização que tem peças dentro

**A exclusão nunca é bloqueada.** Não existe trava do tipo "essa prateleira tem peça, não dá para apagar". Confirmou, a localização vai embora — com 0 ou com 5.000 peças dentro.

1. **As peças não são apagadas.** Continuam no estoque, mesmo SKU, mesma quantidade, mesmo preço. Só perdem o vínculo com o lugar.
2. **Todas as sublocalizações abaixo vão junto**, em cascata, até o último nível — e as peças de cada nível também são soltas. Apagar o "GALPÃO 1" leva corredores, prateleiras e caixas.
3. As peças soltas **não aparecem mais dentro de nenhuma localização**. Para reencontrá-las é scan/etiqueta, uma a uma ou em lote.
4. A tela avisa antes: _"Todos os N subtópico(s) também serão excluídos. Os M produto(s) vinculados serão desvinculados. Esta ação é irreversível."_ Não há desfazer nem lixeira. **A exclusão fica no histórico** — aparece em Colaboradores como "Excluir localização", com quem fez, IP e horário. Até as tentativas que deram erro ficam lá.
5. **Não roda em tudo-ou-nada.** Se estourar no meio, os níveis de baixo já foram apagados e as peças deles já foram soltas. O lojista vê só "Erro ao excluir localização" e acha que nada aconteceu. Deu erro: confira a árvore antes de tentar de novo.

> ⚠️ **O TEXTO DA LOCALIZAÇÃO FICA GRUDADO NA PEÇA COMO FANTASMA.** A peça tem **dois** campos de localização: o vínculo de verdade (usado pela tela de Localizações) e um campo de **texto** (o que aparece escrito no card, na lista e na ficha). A exclusão limpa **só o vínculo** e não limpa o texto. A peça continua mostrando "GALPÃO 1 > CORREDOR A > CX-10", o funcionário vai lá e não acha nada — o lugar nem existe mais. E se alguém abrir e salvar essa peça, o texto velho é regravado.
>
> O botão **"Desvincular"** (dentro da localização, selecionando as peças) limpa **os dois** campos. Desvincular na mão é limpo; apagar a localização deixa sujeira.

> ⚠️ O aviso do diálogo conta **só o nível de baixo**: "N subtópicos" são apenas os filhos diretos e "M produtos" apenas os que estão direto naquele nó. Numa árvore de três níveis o aviso pode dizer "2 subtópicos e 0 produtos" e a exclusão levar 40 caixas e 800 peças.

**Antes de apagar, mova.** Mas saiba que a gaveta de produtos da localização mostra **50 peças por vez, sem "carregar mais"** — o cabeçalho pode dizer "800 produtos vinculados" e a lista mostrar 50, e o "Selecionar todos" marca só esses 50. Prateleira de 800 itens = ~16 rodadas. E se o destino tiver capacidade máxima cadastrada, o sistema recusa por capacidade.

Se apagar sem mover: **não existe filtro "sem localização"** na tela de Produtos para reencontrar as órfãs — e, por causa do texto fantasma, elas nem parecem órfãs.

**Excluir localizações em massa não existe.** Dá para marcar várias com as caixinhas, mas a única ação em massa é "Gerar etiquetas". Criar em massa existe (por faixa, CX-001 a CX-100); apagar em massa não. O único atalho é apagar o pai — e aí vem a cascata inteira.

**Sucata (veículo) vinculada à localização:** a rotina de exclusão trata sublocalizações e **peças**, e não encosta na sucata. Quem decide é a regra do banco, que não dá para ler no código. Pelo padrão que o sistema usa em todas as outras ligações opcionais, o mais provável é que o banco **solte a sucata em silêncio**. E, diferente das peças, **a sucata não guarda endereço em texto** — não sobra nem a pista do lugar antigo, o campo simplesmente fica vazio. Antes de apagar qualquer localização de pátio, abra Sucatas e mova o veículo primeiro. O diálogo de confirmação **nunca menciona veículo/sucata**.
