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

## Validação de CPF e CNPJ

**Depende do caminho.** A conferência de dígito (mod-11) existe em **três** telas e não existe em **três** caminhos automáticos.

**Confere o dígito:** cadastro de cliente, cadastro rápido do Financeiro, cadastro rápido do Orçamento. Documento errado aí é barrado na hora, com "CPF inválido".

**NÃO confere nada:** importação de planilha, cliente criado a partir de pedido de marketplace, e cliente criado automaticamente ao autorizar NF-e. Esses entram do jeito que vierem.

**O servidor** é mais frouxo que a tela — e assimétrico:

- **Ao criar**, confere só o documento que combina com o tipo: cliente PF → CPF com 11 dígitos; cliente PJ → CNPJ com 14. O outro documento entra sem conferência nenhuma.
- **Ao editar**, confere **os dois** (CPF 11 dígitos + duplicado, CNPJ 14 + duplicado), independente do tipo.

> ⚠️ É por isso que **um cliente que entrou torto pela importação pode se recusar a salvar na primeira edição**, com "CNPJ inválido" ou "Já existe um cliente com esse CNPJ" — sem que ninguém tenha mexido no campo. O cadastro passou; a edição é que aperta.

**Importação:** documento que não fecha 11/14 dígitos, ou com todos os dígitos iguais (`000...`, `111...`), é **jogado fora em silêncio** e o cliente entra **sem documento**. Não aparece como erro no relatório do import — e isso também derruba a deduplicação por documento nas próximas importações.

**Duplicidade:** a trava de CPF é por loja (mesmo CPF não repete). **CNPJ não tem trava** — só índice de busca. Cliente sem CPF pode repetir à vontade.

> ⚠️ **A tela de Clientes hoje é só Pessoa Física**, a não ser que `NEXT_PUBLIC_CUSTOMER_PJ_ENABLED=true` esteja ligada no servidor — e ela não está ligada por padrão. Com ela desligada não existe seletor PF/PJ nem campo CNPJ na tela de Clientes: todo cliente criado por ali nasce PF. Os campos de **CNPJ de entrega** do passo de Entrega continuam aparecendo e têm validação de dígito.

Quando a trava do banco é quem barra (em vez do sistema), a tela mostra **erro técnico** em vez de "Já existe um cliente com esse CPF".
