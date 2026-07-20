# Guia — Criar e configurar a conta OLX para integração

> Passo a passo para deixar prontas a conta e as credenciais que o ERP precisa
> para integrar com a OLX. No final há a lista do que preciso de você.

---

## Passo 1 — Contratar plano profissional de Autopeças

- Contrate um **plano profissional da categoria Autopeças**.
- Qual tier serve (autônomo ou Empresa) para liberar integração via API **precisa
  ser confirmado com o comercial da OLX**.
- Contatos do comercial: **0800 022 9800** ou **WhatsApp (11) 95310-6412**.
  Planos: https://planos.olx.com.br/
- Requisito adicional da OLX: **ter um site** da empresa.

## Passo 2 — Confirmar categoria + homologação do integrador

A OLX trabalha com **integradores homologados** (ex.: VAAPT, K2TEC/K2Digital).
Uma integração própria pode precisar de **homologação** para receber o scope
`autoupload` — não basta criar o app. Confirme isso **antes** de se cadastrar.

Envie um e-mail para **`suporteintegrador@olxbr.com`** perguntando:

1. Se a categoria **Autopeças** está liberada para o seu plano via `autoupload`.
2. Se é preciso **homologar um integrador próprio** (ou seja, o ERP) e qual o
   processo.

Guarde as respostas (podem ser pedidas na configuração).

## Passo 3 — Cadastrar como Integrador

- Acesse: https://developers.olx.com.br/
- Faça o cadastro de integrador para a sua conta profissional.
- Ao concluir, a OLX gera:
  - **`client_id`**
  - **`client_secret`**
- É necessário o **scope `autoupload`** (é o que permite enviar anúncios). A
  liberação dele pode depender da homologação confirmada no Passo 2.

## Passo 4 — Autorizar o ERP (login OAuth)

- Depois que eu configurar a integração no sistema, você fará **um login OAuth
  na OLX** autorizando o ERP a gerenciar seus anúncios.
- É feito **uma única vez**; o sistema mantém a conexão depois disso.

---

## O que preciso de você

- [ ] **`client_id`** (portal de integrador)
- [ ] **`client_secret`** (portal de integrador)
- [ ] Fazer o **login OAuth** quando eu pedir

---

## Links úteis

- Portal de integração: https://developers.olx.com.br/
- Documentação da API: https://developers.olx.com.br/anuncio/api/home.html
- Importação de anúncios: https://developers.olx.com.br/anuncio/api/import.html
- Ajuda — integradores: https://ajuda.olx.com.br/s/article/integradores-e-importacao-de-anuncios
