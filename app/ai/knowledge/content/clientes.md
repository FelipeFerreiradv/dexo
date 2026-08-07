# Clientes

A tela **Clientes** (menu Principal → Clientes) é o cadastro de quem compra da loja. Ela tem duas abas: a **lista de clientes** e o **funil de orçamentos**.

O cadastro alimenta a venda de balcão, o orçamento, a conta a receber e a nota fiscal — os dados fiscais da nota saem daqui.

## Cadastrar um cliente

Botão de novo cliente. Quatro etapas:

1. **Identificação** — pessoa física ou jurídica e os documentos.
2. **Contato** — e-mail, telefone, celular.
3. **Endereço** — CEP, rua, número, complemento, bairro, cidade, estado.
4. **Entrega / PJ** — endereço de entrega quando diferente, e os dados de pessoa jurídica.

**Pessoa física** pede nome, CPF, RG, data de nascimento. **Pessoa jurídica** pede CNPJ, razão social, nome fantasia, inscrição estadual e o indicador de inscrição estadual (contribuinte, isento ou não contribuinte).

O indicador de IE importa para a nota fiscal — é ele que define como o destinatário é tratado no XML.

Nada além do nome é obrigatório no cadastro; o resto é exigido pela nota fiscal na hora de emitir, não aqui.

## Cliente criado sozinho

Quando um pedido chega de um marketplace, se o comprador ainda não existe, o Dexo **cria o cliente automaticamente** com o que o marketplace informou. Isso mantém o histórico de compras ligado à pessoa certa desde a primeira venda.

Cliente criado assim costuma vir sem CPF e sem endereço completo — o marketplace nem sempre entrega esses dados. Antes de emitir nota para ele, é preciso completar o cadastro.

Também dá para criar um cliente na hora, direto de dentro da venda de balcão ou do orçamento, sem sair do fluxo.

## Histórico de compras

Abrindo um cliente, dá para ver as compras dele — vendas de balcão e pedidos de marketplace vinculados.

## Fornecedores

O Dexo não tem cadastro separado de fornecedor. **Contas a Pagar também aponta para um cliente**, então o fornecedor é cadastrado aqui como pessoa jurídica.

## Excluir

Cliente com conta, venda ou orçamento vinculado **não pode ser excluído** — apagá-lo deixaria o histórico financeiro órfão. Cliente que só tem pedido de marketplace vinculado pode ser excluído: o pedido continua existindo, sem o vínculo.

## Erros comuns

- **Não consigo excluir o cliente** — ele tem conta a receber, conta a pagar ou orçamento. É proteção do histórico.
- **Nota fiscal recusada por dados do destinatário** — cadastro incompleto, quase sempre criado automaticamente por um pedido. Completar CPF/CNPJ, endereço e IE.
- **Cliente duplicado** — o mesmo comprador comprou por dois marketplaces com dados diferentes. Não há junção automática de cadastros.

## Limitações conhecidas

- Não há junção (merge) de clientes duplicados.
- Não há busca de endereço por CEP integrada.

> ⚠️ PENDENTE DE CONFIRMAÇÃO: se existe validação de CPF/CNPJ no cadastro (dígito verificador) ou se o campo aceita qualquer texto. Não confirmei na tela, e a resposta muda o que eu digo a quem reclamar de "documento inválido".
