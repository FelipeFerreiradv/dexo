# Guia — Criar e configurar a conta Facebook/Meta para integração

> Passo a passo para deixar prontas a conta e as credenciais que o ERP precisa
> para integrar com o Facebook/Meta. No final há a lista do que preciso de você.

> **Atenção — leia antes:** o Facebook **não tem API pública de Marketplace**.
> A "Marketplace Partner API" é *invite-only* (Meta aprova caso a caso, em geral
> veículos, imóveis e grande varejo). O caminho realista para autopeças é o
> **Meta Commerce / Catálogo** (Facebook & Instagram Shops): os produtos aparecem
> na loja da Meta, **não** como anúncio clássico do Marketplace. No Brasil o
> checkout é **fora da plataforma** (redireciona para o site), então **não há
> webhook de pedido nem baixa de estoque automática** — mesma limitação da OLX.

---

## Passo 1 — Criar o Meta Business Manager

- Acesse: https://business.facebook.com/
- Crie (ou confirme) o **Business Manager** da empresa: nome, CNPJ e dados
  fiscais.
- Recomendado: ter um **site** da empresa (usado em vários cadastros da Meta).

## Passo 2 — Página do Facebook + Instagram

- Crie (ou vincule) a **Página do Facebook** da loja.
- Vincule uma **conta Instagram** (recomendado para as Shops).
- Deixe ambas sob o Business Manager do Passo 1.

## Passo 3 — Commerce Manager (Catálogo + Loja)

- Acesse: https://business.facebook.com/commerce/
- Crie um **Catálogo** de produtos.
- Crie uma **conta de Commerce / Loja (Shop)** vinculada à Página e ao Instagram.
- Anote o **ID do Catálogo** (o ERP precisa dele para publicar os produtos).

## Passo 4 — Criar o App de desenvolvedor na Meta

- Acesse: https://developers.facebook.com/
- Crie um **App** do tipo **Business**. Ao concluir, a Meta gera:
  - **`App ID`**
  - **`App Secret`**
- É o mesmo modelo de app Meta que o sistema já usa no WhatsApp.

## Passo 5 — Autorizar o ERP (login OAuth)

- Depois que eu configurar a integração no sistema, você fará **um login OAuth
  na Meta** autorizando o ERP a gerenciar o catálogo.
- É feito **uma única vez**; o sistema mantém a conexão depois disso.

## (Opcional) Marketplace Partner API

- Só se quiser tentar o Marketplace de verdade (anúncio clássico):
  https://developers.facebook.com/docs/marketplace/partnerships/sellerAPI/
- Aprovação depende da Meta, **não é garantida nem rápida**. Não conte com isso
  para o prazo.

---

## O que preciso de você

- [ ] **`App ID`** (app na Meta)
- [ ] **`App Secret`** (app na Meta)
- [ ] Acesso de **admin** ao Business Manager, à Página e ao Catálogo
- [ ] **ID do Catálogo** / da conta de Commerce
- [ ] Fazer o **login OAuth** quando eu pedir

---

## Links úteis

- Business Manager: https://business.facebook.com/
- Commerce Manager: https://business.facebook.com/commerce/
- Meta for Developers: https://developers.facebook.com/
- Marketplace Partner API (opcional): https://developers.facebook.com/docs/marketplace/partnerships/sellerAPI/
