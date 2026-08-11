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

## Quanto tempo a venda demora para virar pedido

**Até cerca de 15 minutos** — contados de quando o marketplace confirma o **pagamento**, não de quando o comprador clicou em comprar.

Nem a Shopee nem o Magalu avisam o Dexo na prática: o endereço de aviso existe e confere assinatura, mas o histórico de produção mostra **zero avisos recebidos** dos dois canais. Quem vai buscar é o Dexo, a cada 15 minutos.

**O que faz demorar mais:**

**0. A conta caiu — e aí não vem nunca.** Se o token da Shopee/Magalu expirou e a renovação falhou, o Dexo marca a conta como **ERRO**. A partir daí a venda não chega por caminho nenhum: nem na passada de 15 minutos, nem pelo botão "Importar Pedidos" (que responde _"Conta não conectada ou sem credenciais"_), nem por aviso automático. Não existe espera — é reconectar em Integrações ou nada. **Sintoma típico: pararam de entrar pedidos de UM canal enquanto os outros seguem normais.**

**1. A venda ainda não está paga.** Na Shopee, pedido `UNPAID` não é importado. No Magalu, só entra em pago / aprovado / processando / faturado / enviado / entregue — "novo" fica de fora. O relógio só começa aí.

**2. O anúncio não está ligado a um produto.** O pedido vira **Pendência**. O sistema tenta sozinho com espera crescente (1 min → 5 → 15 → 30 → de hora em hora) e uma varredura geral a cada 10 minutos. Depois de 5 tentativas sem item vinculado, sai da fila automática e fica "precisa de ação".

**3. Muitas contas conectadas.** A passada processa 4 contas por vez. Se demorar mais que 15 minutos, a próxima começa 5 segundos depois — o intervalo real vira a duração da passada.

**Não quer esperar:** botão **"Importar Pedidos"** na tela de Pedidos, que puxa na hora dos três canais, últimos 7 dias, já com baixa de estoque.

> ⚠️ **O botão "Tentar novamente" da pendência só re-busca o pedido quando é da SHOPEE.** Em pendência do Magalu (e do Mercado Livre) ele apenas confere se o pedido já entrou; se ainda não entrou, não acontece nada visível. Depois de cadastrar a peça numa pendência Magalu/ML, clique em **"Importar Pedidos"** — e só então o "Tentar novamente" fecha.

> ⚠️ Enquanto a conta estiver em ERRO, as pendências dela seguem **contando tentativas sem nunca poder resolver** — e por isso viram "precisa de ação" rápido, mesmo com a peça já cadastrada.

**Diferenças entre os canais:**

- **Shopee** — busca pela **data de última atualização**, não pela de criação: pedido de semana passada que mudou de estado hoje também entra. Janela de 7 dias; a API não aceita mais de 15 dias por consulta, e o Dexo guarda uma marca d'água com 6 h de folga para recuperar atraso (até 90 dias) se o servidor ficar fora. Se algum pedido der erro no ciclo, a marca d'água não avança.
- **Magalu** — janela de 7 dias por data de atualização, mas **esse filtro nunca foi confirmado contra a API real** (está anotado como pendente no código). Se o Magalu ignorar o filtro, o Dexo lê as páginas até o teto de 500 pedidos.

Os 15 minutos, a busca por data de atualização e o descarte só de `UNPAID` são o comportamento **padrão** — existem chaves no servidor que revertem cada um deles.
