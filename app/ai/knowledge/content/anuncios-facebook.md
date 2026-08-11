# Anúncios no Facebook

O Dexo publica peças do catálogo no **catálogo de produtos da Meta** — o mesmo que alimenta a loja do Facebook e do Instagram — e mantém preço e estoque em sincronia. A tela fica em **Marketplaces → Facebook**, com três abas: **Conexão**, **Anúncios** e **Sincronização**.

## Não é o Marketplace do Facebook

Vale começar por aqui, porque a confusão é comum e muda a expectativa inteira.

O que o Dexo alimenta é o **catálogo de produtos** da Meta: a vitrine da sua página e do seu perfil comercial. **Não** é o Marketplace clássico, aquele mural onde qualquer pessoa anuncia um sofá usado — a integração daquele mural é fechada e não está aberta a sistemas de gestão.

A diferença prática: seus itens aparecem na sua loja do Facebook e do Instagram, e o comprador fala com você para fechar. **Não existe checkout no Brasil**, então a Meta não devolve pedido para o Dexo. Estoque baixado por venda pelo Facebook é sempre baixa manual, no Dexo.

## Conectar uma conta

Na aba **Conexão**, botão de conectar. A autorização acontece no site da Meta, com uma conta que administre a página comercial — o mesmo modelo do WhatsApp.

Cada conta conectada aponta para **um catálogo**. Sem o catálogo configurado na conta, a sincronização de estoque não sai e o Dexo diz exatamente isso, em vez de publicar no catálogo errado.

**Só o administrador conecta e desconecta contas.**

## O endereço do item

Todo item de catálogo da Meta exige um **link**. Como uma peça de desmonte não tem vitrine própria na internet, todos os itens apontam para a **mesma página** do vendedor, configurada uma vez na integração. Sem essa configuração a publicação real falha.

## Publicar

O envio é **em lote**: o Dexo monta o pacote de itens, envia e confere o resultado.

O que vai por item:

- **Nome** — o nome da peça, cortado em 200 caracteres.
- **Descrição** — a descrição da peça, cortada em 9.999 caracteres. Peça sem descrição publica o próprio nome.
- **Preço** e moeda.
- **Fotos** — até 20; a primeira é a principal.
- **Marca** — quando cadastrada na peça, vai em campo próprio.
- **Disponibilidade e quantidade** — espelham o estoque do Dexo.
- **Categoria** — a taxonomia de produtos do Google.
- **Código do item** — o SKU da peça.

## O nome da peça vai cru

Como na OLX e ao contrário da Shopee, o Dexo **não** monta o título juntando marca, modelo, ano e part number. O nome da peça vai como está cadastrado.

A marca é a única exceção: quando a peça tem marca cadastrada, ela vai num campo próprio do item. Modelo e ano só aparecem se estiverem escritos no nome.

## Categoria: a taxonomia do Google

A Meta não tem árvore de categorias consultável como os outros canais. O sinal de categoria é a **taxonomia de produtos do Google**, e o Dexo escolhe entre peça de veículo motorizado, peça de moto e peça de embarcação pela palavra no **nome da peça** — caindo em peça de veículo motorizado quando não encontra nada.

O casamento é por palavra inteira: "Retrovisor Moto Honda" vai para peça de moto; "Suporte do Motor Gol" não vai.

Para forçar outra taxonomia, use o campo de categoria do Facebook no cadastro do produto. Ele vence a escolha automática.

## Estoque zero não apaga o item

Quando o estoque de uma peça chega a zero, o Dexo marca o item como **indisponível** no catálogo e registra o anúncio como pausado. O item **continua existindo** — com histórico, com endereço, com as fotos.

Quando a peça volta ao estoque, o item volta a disponível com a quantidade nova. É diferente da OLX, onde despublicar significa excluir.

## Trazer para o Dexo o que já está no catálogo

Diferente da OLX, o catálogo da Meta **pode ser lido**. Isso destrava duas coisas:

**Importação sob demanda.** A aba de importação lê o catálogo da conta e amarra cada item à peça do Dexo que tenha o **mesmo SKU**. Item cujo SKU não existe no catálogo do Dexo fica de fora — não vira peça nova.

**Detecção automática de itens novos.** Existe uma rotina que faz isso sozinha a cada ciclo de sincronização, e ela **nasce desligada**, de propósito. O critério de "novo" é *ainda não vinculado*, não *criado recentemente* — a Meta não devolve data de criação confiável. Consequência: **na primeira passada, tudo que ainda não estiver vinculado é importado de uma vez**. Ligue primeiro em uma conta, confira o resultado, e só então estenda.

## Sincronização

Preço e estoque vão do Dexo para a Meta. Alterar o preço de uma peça anunciada — pela tela de Produtos ou pelo chat — atualiza o item do catálogo junto com os anúncios dos outros canais.

## Quando o item não sai

O motivo devolvido pela Meta fica guardado no anúncio e aparece na aba Anúncios e no diagnóstico da operação.

Recusa **definitiva** não é tentada de novo. Falha **passageira** volta para a fila com espera crescente, até cinco tentativas.

## O que o Facebook não faz

- **Pedido** — não há checkout no Brasil; a venda fecha na conversa.
- **Mensagem do comprador dentro do Dexo** — a conversa acontece nas ferramentas da Meta.
- **Etiqueta de envio** — não há logística da plataforma.
- **Marketplace clássico** — a integração é do catálogo da loja, não do mural de classificados.
