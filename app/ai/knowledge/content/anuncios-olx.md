# Anúncios na OLX

O Dexo publica peças do catálogo como anúncios na OLX e mantém preço e estoque em sincronia. A tela fica em **Marketplaces → OLX**, com três abas: **Conexão**, **Anúncios** e **Sincronização**.

A OLX é um **classificado**, não uma loja com carrinho. Isso muda quase tudo em relação ao Mercado Livre: quem compra fala com você por telefone, e a venda acontece fora da plataforma. Por isso a OLX **não devolve pedido, não devolve mensagem do comprador e não gera etiqueta de envio** — e o Dexo não tem como inventar nada disso.

## Conectar uma conta

Na aba **Conexão**, botão de conectar. A autorização acontece no site da própria OLX.

Duas diferenças em relação aos outros canais, e as duas custam tempo quando se descobre na hora errada:

**As credenciais não são self-service.** A OLX não tem um portal onde você cria o aplicativo sozinho — o acesso é liberado pelo time de integração da OLX, por solicitação. Sem isso a conexão não abre.

**A autorização da OLX não se renova sozinha.** Os outros canais devolvem uma credencial de renovação e o Dexo reconecta em silêncio. A OLX não devolve. Quando a autorização cai, alguém precisa entrar em Conexão e autorizar de novo — e enquanto isso não acontece, nenhuma publicação e nenhuma sincronização saem.

**Só o administrador conecta e desconecta contas.** Colaboradores usam as contas já conectadas.

## O contato do vendedor

Todo anúncio da OLX exige **telefone e CEP do vendedor**. Esses dados não vêm da peça nem do cadastro do produto: eles ficam na configuração da conexão da OLX, e são os mesmos para todos os anúncios daquela conta.

Se eles não estiverem preenchidos na conta, a publicação usa um valor de configuração do servidor. Com mais de um vendedor conectado, isso faz o contato de um aparecer no anúncio do outro — então preencher os dados na aba Conexão não é opcional.

## Publicar um anúncio

A publicação da OLX é **em lote e assíncrona**. O Dexo monta o lote, envia, recebe um comprovante e depois consulta o resultado. Um anúncio recém-enviado costuma aparecer como **pendente**: ele está na fila de revisão da OLX, não travado no Dexo.

O que o Dexo envia por anúncio:

- **Título** — o nome da peça, cortado em 90 caracteres.
- **Descrição** — a descrição da peça, cortada em 6.000 caracteres. Peça sem descrição publica o próprio nome no corpo do anúncio.
- **Preço** — arredondado para número inteiro.
- **Fotos** — até 20; a primeira é a principal.
- **Categoria** — o tipo de veículo.
- **Telefone e CEP** — os da conta.

## O nome da peça é o anúncio inteiro

Na Shopee o sistema monta o título juntando nome, marca, modelo, ano e part number. **Na OLX não.** O Dexo manda o nome da peça exatamente como está cadastrado.

A consequência é direta: marca, modelo e ano só aparecem no anúncio se estiverem escritos no nome. "Farol dianteiro esquerdo" vira um anúncio que não diz de que carro é.

## O preço perde os centavos

O anúncio da OLX só aceita valor inteiro. O Dexo **arredonda** na publicação: R$ 180,50 vira R$ 181 e R$ 180,49 vira R$ 180.

O preço no Dexo continua com os centavos — quem arredonda é o anúncio. Uma peça que aparece na OLX por um real a mais do que o cadastro não é erro de sincronização.

## Categoria: é o veículo, não a peça

Na OLX a categoria de autopeça é o **tipo de veículo** — carros e utilitários, caminhões, motos, barcos e aeronaves, ônibus. O tipo da peça vai em outro campo, preenchido pelo Dexo.

A escolha sai do **nome da peça**, por palavra inteira, e cai em carros quando não encontra nada. Palavra inteira importa: "Retrovisor Moto Honda" vai para Motos, e "Suporte do Motor Gol" **não** vai — "motor" não é "moto".

Para forçar outro veículo, use o campo de categoria da OLX no cadastro do produto. Ele vence a escolha automática.

## O código do anúncio vem do SKU

A OLX identifica o anúncio por um código de no máximo **19 caracteres**. O Dexo usa o SKU da peça, trocando caractere inválido por sublinhado. SKU mais longo que 19 caracteres é encurtado com um sufixo automático, para dois SKUs parecidos não virarem o mesmo anúncio.

## Pausar na OLX é excluir

**A OLX não tem "pausar".** Despublicar um anúncio na OLX é **excluí-lo**, e reativar é publicá-lo de novo — um anúncio novo, com endereço novo.

Isso é importante quando o estoque zera: uma peça vendida sai do ar de verdade, e quando ela volta ao estoque o anúncio é recriado. Comentário, visualização e histórico daquele anúncio não voltam.

## Sincronização

Preço e estoque vão do Dexo para a OLX, **sempre nesse sentido**. Alterar o preço de uma peça anunciada — pela tela de Produtos ou pelo chat — atualiza o anúncio da OLX junto com os dos outros canais.

O caminho contrário não existe: a OLX não devolve a lista de anúncios da conta, então o Dexo não consegue descobrir anúncios criados direto no site da OLX nem importá-los. Só existe no Dexo o que saiu do Dexo.

## Quando o anúncio não sai

A OLX costuma responder que recebeu a requisição **e**, dentro da resposta, que recusou o anúncio. O Dexo lê essa segunda parte e guarda o motivo no anúncio — é o que aparece na aba Anúncios e no diagnóstico da operação.

Recusa **definitiva** (preço fora do aceitável, plano sem vaga) não é tentada de novo: insistir a cada minuto não muda a resposta. Falha **passageira** (rede, instabilidade) volta para a fila com espera crescente, até cinco tentativas.

## O que a OLX não faz

- **Pedido** — a venda acontece fora da plataforma.
- **Mensagem do comprador** — o contato é por telefone, direto com você.
- **Etiqueta de envio** — não há logística da plataforma.
- **Importar anúncios existentes** — a API não lista os anúncios da conta.
- **Pausar sem excluir** — ver acima.
