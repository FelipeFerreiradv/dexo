# Produtos e cadastro de peças

A tela **Produtos** (menu Principal → Produtos) é o catálogo da loja: toda peça que existe fisicamente no galpão tem um produto aqui. É de onde saem os anúncios, as etiquetas, a venda no balcão e a nota fiscal. Se a peça não está cadastrada, ela não existe para o resto do sistema.

Cada produto pertence a UMA loja (o tenant). Colaboradores enxergam o catálogo do administrador a que estão vinculados, nunca o de outra loja.

## Cadastrar uma peça nova

No topo da tela Produtos, botão **Novo Produto**. O cadastro é um passo a passo:

1. **Identificação** — SKU, Part Number, Nome do produto e descrição.
2. **Imagem** — as fotos da peça.
3. **Preços e Estoque** — custo, margem, preço de venda, quantidade, localização e sucata de origem.
4. **Veículo e Peça** — qualidade, marca, modelo, ano, versão, medidas, peso, veículo de origem.
5. **Compatibilidade** — em quais veículos a peça serve.
6. **Mercado Livre** — categoria, conta e ficha técnica do anúncio.
7. **Shopee** — o mesmo para a Shopee.
8. **Magalu** — só aparece quando a integração Magalu está habilitada para a loja.
9. **Prévia** — como o anúncio vai ficar antes de publicar.
10. **Revisão** — a conferência final antes de salvar.

Só três campos são obrigatórios: **Nome do produto**, **Preço de venda** e **Quantidade em estoque**. Fotos são exigidas quando o produto vai virar anúncio.

Não é preciso passar por todos os passos: quem só quer a peça no estoque preenche Identificação, Imagem e Preços e Estoque e salva.

## SKU: como o número é escolhido

O SKU é o código da peça dentro da loja. Ele é **único por loja** — duas peças da mesma loja não podem ter o mesmo SKU, mas lojas diferentes podem usar o mesmo número sem conflito.

O sistema sugere o próximo número da sequência automaticamente, com três dígitos e zeros à esquerda (`001`, `002`, `047`, `1024`). O número só é reservado de fato na hora de salvar, e o servidor decide qual é — por isso dois colaboradores cadastrando ao mesmo tempo nunca recebem o mesmo SKU.

O campo é editável: dá para digitar um código próprio (`ESC-P1`, um código de barras, o código do fornecedor). Códigos assim **não** avançam a numeração automática, então a sequência humana continua limpa.

Peças que entram por importação de planilha ou por detecção automática de anúncio também não mexem no contador.

## Preço de custo e margem

Ao informar **Preço de custo** e **Preço de venda**, a **Margem (%)** é calculada sozinha. O contrário também vale: informando custo e margem, o preço de venda sai calculado.

O preço de custo e a margem são informação **interna da loja**. Não vão para anúncio, nem para nota, nem para cupom, e nunca são usados em comparação com outras lojas.

## Descrição padrão

Em **Configurações → Produto → Descrição padrão** dá para gravar um texto que entra automaticamente em todo produto novo que for salvo sem descrição (garantia, condições de envio, telefone da loja). O texto continua editável em cada peça.

Na mesma tela há **Preço de custo padrão** e **Quantidade padrão em estoque**, que pré-preenchem o formulário.

## Preenchimento automático a partir do nome

Ao salvar, se **Marca**, **Modelo**, **Ano** ou **Categoria** estiverem vazios, o sistema tenta deduzi-los do nome do produto. Um nome como "Farol Dianteiro Direito Gol G5 2010" já preenche marca e modelo sozinho.

O que o usuário digitou nunca é sobrescrito: a dedução só preenche campo em branco.

## Sugestões da base da plataforma

No cadastro há um botão de **sugestão interna**: a partir do nome da peça, o sistema procura peças equivalentes no conjunto agregado da plataforma e propõe preço, peso, medidas, categoria e compatibilidades.

O que aparece são **medianas e valores mais frequentes** de um grupo — nunca a peça de uma loja específica, nunca de qual loja veio, nunca o custo de ninguém. Grupos com menos de 5 peças não geram sugestão nenhuma: com amostra pequena o número seria só o preço de um concorrente.

Aceitar uma sugestão preenche os campos; tudo continua editável.

Os números são recalculados por um processamento que roda uma vez por dia, então refletem o catálogo de até cerca de 24 horas atrás.

## Buscar uma peça

A busca da tela Produtos entende abreviação de autopeça. `fecha tras esq palio` encontra "Fechadura Traseira Esquerda Palio": a frase é quebrada em termos, cada termo é expandido (`tras` → traseira/traseiro, `esq` → esquerda/esquerdo, `dt`/`tr`, `le`/`ld`) e a peça precisa casar com **todos** os termos.

Buscar por um código (`ABC-1`, `043`, código de barras) é tratado como busca exata de SKU/part number: se aquele código não existe, o resultado é vazio em vez de uma lista de peças parecidas.

Buscar por uma palavra só, sem número (`molla`), tolera erro de digitação.

## Editar e excluir

Editar um produto que já tem anúncio publicado **dispara sincronização com os marketplaces na hora**: título, preço, fotos e ficha técnica alterados sobem para o Mercado Livre, a Shopee e o Magalu conforme onde a peça está anunciada. Não é preciso republicar nada à mão.

Alterar o **estoque** também sincroniza — é o que evita vender uma peça que já saiu.

A exclusão em massa está na própria lista, selecionando as peças. Excluir um produto é definitivo.

## Quando a exclusão da peça é barrada

Não existe uma tela única de "não pode excluir". Cada caso se comporta de um jeito.

**⚠️ A ordem das coisas é o que mais surpreende:** o Dexo primeiro **encerra os anúncios** da peça no Mercado Livre, na Shopee e no Magalu. Só depois tenta apagar a peça do banco. Se a peça não puder ser apagada, os anúncios **já foram destruídos** — e a janela de resultado não dá nenhuma pista disso. A peça continua no Dexo, sem anúncio nenhum.

- **Peça com anúncio** — não barra. O anúncio é encerrado junto (no ML vira `closed`, na Shopee o item é apagado). Se algum anúncio não puder ser encerrado (conta desconectada, erro do canal), a peça **não** é apagada: abre a janela "Resultado da exclusão" com o placar, o motivo por anúncio, uma etiqueta _Recuperável_ ou _Definitivo_, e o botão "Reintentar".
- **Peça com pedido** (venda de marketplace) — **barrada**, com mensagem em português: _"Não é possível deletar o produto pois ele possui pedidos associados"_. O botão "Reintentar" aparece, mas nunca vai funcionar: o bloqueio dura enquanto o pedido existir.
- **Peça vendida no balcão, ou dentro de um orçamento** — **barrada**, mas com mensagem **técnica e feia**: o texto cru do banco, algo como `Foreign key constraint violated on the constraint: ReceivableItem_productId_fkey` (ou `BudgetItem_productId_fkey`). Significa apenas: essa peça já foi vendida no balcão (ou está num orçamento) e por isso não pode ser apagada.
- **Peça em nota fiscal emitida** — a nota guarda cópia própria da descrição, código, NCM, CFOP e valores, então ela não depende da peça para continuar válida.

> ⚠️ Se a NF-e **barra** ou não a exclusão não dá para provar pelo código: essa ligação foi criada por DDL manual, fora do repositório. Trate como "provavelmente não barra" e confirme na prática antes de prometer.

**Vai junto, sem aviso:** todo o histórico de movimentação de estoque da peça e as compatibilidades de veículo. Some definitivamente.

**Cancelar o orçamento NÃO solta a peça.** Cancelar só muda o status; os itens continuam lá segurando. Só **excluir** o orçamento libera.

**O que fazer no lugar:** peça que já vendeu não se apaga — deixe cadastrada com estoque 0, porque o histórico depende dela. Se o problema é continuar anunciada, **pause** os anúncios.

## Excluir várias peças de uma vez

Marcando as peças aparece "Excluir selecionados". A regra é a mesma, peça por peça, e no fim abre a janela com o placar e uma linha por peça — verde para as que saíram, vermelha com o motivo para as que ficaram.

- **O teto real é 100**, que é o máximo de "Itens por página". **Não dá para acumular seleção entre páginas:** virar a página, trocar o tamanho da página, mexer no filtro ou na ordenação **apaga tudo que você marcou, sem avisar**. Para apagar muita coisa, ponha 100 por página e vá de 100 em 100.
- **Se der erro vermelho no meio, não conclua que nada foi apagado.** As peças dos primeiros lotes podem já ter sido excluídas de verdade, mesmo continuando visíveis na tela. Atualize a página (F5) antes de tentar de novo.
- A confirmação da exclusão em massa **avisa** que os anúncios serão fechados e que peças com pedido não serão excluídas. A confirmação da exclusão **individual** — a lixeira de uma peça só, que é a mais usada — **não avisa nada disso**, só diz "Esta ação é irreversível".

## Erros comuns

- **"Produto com esse sku já existe"** — outra peça da loja já usa esse SKU. Trocar o código ou deixar o sistema sugerir o próximo.
- **Peça não aparece na busca** — conferir se a palavra buscada está mesmo no nome, na marca, no modelo ou no part number. A busca exige que todos os termos casem.
- **Sugestão interna não retorna nada** — a base agregada não tem 5 peças equivalentes. É esperado em peça rara; não é falha.
- **Anúncio não reflete a edição** — a sincronização é disparada na hora, mas depende do marketplace aceitar. O erro fica registrado no anúncio, na aba de anúncios do produto.

## Limitações conhecidas

- Não existe rascunho de produto: ou a peça é salva, ou nada é gravado.
- O preço de custo não entra em nenhum relatório de margem consolidado por período.
- A dedução de marca/modelo pelo nome é uma heurística; nomes fora do padrão podem não render nada.
