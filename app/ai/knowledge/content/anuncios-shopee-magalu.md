# Anúncios na Shopee e no Magalu

Além do Mercado Livre, o Dexo publica em **Shopee** e **Magazine Luiza**. As telas ficam em **Marketplaces → Shopee** e **Marketplaces → Magazine Luiza**, com as mesmas três abas: **Conexão**, **Anúncios** e **Sincronização**.

O modelo é o mesmo dos anúncios do Mercado Livre: a peça é uma só no catálogo, cada canal tem o seu anúncio, e o **estoque é compartilhado** entre todos. Vendeu em um canal, os outros são atualizados.

O Mercado Livre é a referência de comportamento do Dexo. Quando Shopee e Magalu diferem, é porque a API deles impõe a diferença — não porque o Dexo escolheu.

## Conectar a Shopee

Aba **Conexão** → **Conectar Shopee**. A autorização abre no site da Shopee e volta para o Dexo.

A Shopee valida o **endereço de IP** de quem chama a API dela. A autorização precisa ser feita a partir do ambiente autorizado; conexão feita de outra origem é recusada pela Shopee mesmo com as credenciais certas.

Como no Mercado Livre, **só o administrador conecta e desconecta contas**.

## Conectar o Magalu

Aba **Conexão** da tela do Magazine Luiza. Dois detalhes que costumam travar a conexão:

- Faça a autorização em um **navegador limpo** (janela anônima) — sessão antiga do Magalu atrapalha o retorno.
- O endereço de retorno configurado não pode terminar em barra.

O módulo Magalu fica atrás de uma habilitação: se a loja não tem a integração ligada, o item nem aparece no menu.

## Publicar

O caminho é o mesmo dos anúncios do Mercado Livre: no cadastro do produto há um passo **Shopee** (e um **Magalu**, quando habilitado), e o assistente de anúncio em massa permite selecionar contas dos três canais na primeira etapa.

Cada canal tem a sua própria árvore de categorias e a sua própria ficha técnica obrigatória. A categoria escolhida para o Mercado Livre não serve para a Shopee, e vice-versa — por isso são passos separados.

## Preço escalonado

O acréscimo percentual entre contas configurado em **Configurações → Preços entre contas** também vale para Shopee e Magalu, com a mesma regra: a primeira conta sai com o preço do produto e as seguintes com o acréscimo.

Cada anúncio também aceita preço próprio, que sobrescreve o do produto só naquele canal.

## Pedidos e sincronização

A Shopee **não avisa o Dexo quando acontece uma venda**: o sistema é quem vai buscar os pedidos periodicamente. É a diferença prática mais importante em relação ao Mercado Livre, que envia aviso.

Consequência: entre a venda na Shopee e a baixa de estoque no Dexo existe uma janela. Ela é curta na operação normal, mas não é instantânea.

A aba **Sincronização** mostra o histórico de ciclos e o que deu errado em cada um.

## Erros comuns

- **Shopee recusa a conexão mesmo com as credenciais certas** — a autorização não partiu de um endereço autorizado pela Shopee.
- **Magalu não conclui a conexão** — sessão antiga no navegador ou endereço de retorno com barra no fim.
- **Anúncio recusado por ficha técnica** — a categoria escolhida exige um campo que o produto não tem preenchido.
- **Venda da Shopee demorou a aparecer** — esperado: a Shopee é consultada em ciclos, não avisa sozinha.
- **Menu do Magalu não aparece** — a integração não está habilitada para a loja.

## Limitações conhecidas

- Não há rascunho de anúncio em nenhum dos canais.
- Estoque nunca é individual por anúncio — a peça física é uma só.
- Os campos de "modelo" da Shopee não são modelo de carro; é a nomenclatura de variação de produto da própria Shopee e não tem relação com compatibilidade veicular.

> ⚠️ PENDENTE DE CONFIRMAÇÃO: quanto tempo, na prática, o cliente costuma esperar entre a venda na Shopee e o pedido aparecer no Dexo. O intervalo é configurável no servidor e prefiro não cravar um número que pode não ser o da instalação dele.
