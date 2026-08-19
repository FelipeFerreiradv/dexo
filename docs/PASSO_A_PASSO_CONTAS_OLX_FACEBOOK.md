# Passo a passo — Criação de contas para integração (OLX + Facebook/Meta)

> Documento para o cliente. Objetivo: deixar prontas as contas e credenciais de
> desenvolvedor necessárias para integrar o ERP à **OLX** e ao **Facebook
> Marketplace / Meta**, seguindo o mesmo modelo já usado com Mercado Livre,
> Shopee e Magalu.
>
> **Leia antes de começar:** há limitações importantes em cada plataforma
> (resumidas ao final de cada seção). O que a OLX e o Facebook permitem via API
> **não é idêntico** ao que existe hoje no Mercado Livre/Shopee. Alinhe as
> expectativas antes de contratar planos.

---

## 1. OLX

A OLX tem API oficial de integração de anúncios ("autoupload"). Ela **publica,
edita e remove anúncios** — não notifica vendas nem controla estoque
automaticamente (a venda na OLX acontece pelo chat, fora da plataforma).

### O que criar / contratar

1. **Conta OLX Profissional — Plano Empresa**
   - Desde janeiro/2025, planos de anunciante **autônomo NÃO têm acesso à API**.
     É obrigatório um **plano Empresa** (vertical Autos).
   - Contrate em: https://www.olx.com.br/ (área de planos profissionais) ou pelo
     time comercial da OLX.

2. **Cadastro de Integrador (portal de desenvolvedores)**
   - Acesse: https://developers.olx.com.br/
   - Faça o cadastro como integrador. Ao final você recebe:
     - `client_id`
     - `client_secret`
   - Solicite o **scope `autoupload`** (necessário para importar anúncios).

3. **Confirmar a categoria de autopeças**
   - A API cobre oficialmente Autos, Peças, Imóveis e alguns gerais, mas o acesso
     de integração é liberado caso a caso.
   - **Envie um e-mail para `suporteintegrador@olxbr.com`** perguntando
     explicitamente se a categoria **Autopeças** está liberada para o seu
     plano Empresa via API `autoupload`. Guarde a resposta.

4. **Autorizar o app do ERP (OAuth)**
   - Depois que o desenvolvedor configurar a integração, você fará um login OAuth
     na OLX autorizando o ERP a gerenciar seus anúncios. Isso é feito 1 vez.

### Informações que o desenvolvedor vai precisar de você

- `client_id` e `client_secret` do portal de integrador
- Confirmação por escrito da OLX sobre a categoria autopeças
- Login autorizado (OAuth) quando solicitado

### Limitação importante (OLX)

- A API **só publica/edita/remove anúncio**. **Não existe webhook de pedido nem
  baixa de estoque automática** — a OLX é um classificado, a venda ocorre no
  chat. A "baixa de estoque por venda" que existe no Mercado Livre **não é
  possível na OLX** pela API.

Links úteis:
- Portal de integração: https://developers.olx.com.br/
- Importação de anúncios (API): https://developers.olx.com.br/anuncio/api/import.html
- Ajuda sobre integradores: https://ajuda.olx.com.br/s/article/integradores-e-importacao-de-anuncios

---

## 2. Facebook Marketplace / Meta

**Atenção:** o Facebook **não tem API pública de Marketplace**. Só parceiros
aprovados pela Meta (invite-only, geralmente veículos, imóveis e grande varejo)
acessam a "Marketplace Partner API". O caminho realista para um ERP de autopeças
é o **Meta Commerce / Catálogo** (Facebook & Instagram Shops), que exibe os
produtos nas lojas da Meta — não como anúncio clássico do Marketplace.

### O que criar

1. **Conta comercial — Meta Business Manager**
   - Acesse: https://business.facebook.com/
   - Crie/confirme o Business Manager da empresa (nome, CNPJ, etc.).

2. **Página do Facebook + conta do Instagram**
   - Crie (ou vincule) a **Página do Facebook** da loja.
   - Vincule uma **conta Instagram** (recomendado para Shops).

3. **Commerce Manager (catálogo + loja)**
   - Acesse: https://business.facebook.com/commerce/
   - Crie um **Catálogo** de produtos.
   - Crie uma **conta de Commerce / Loja (Shop)** vinculada à Página e ao Instagram.

4. **App de desenvolvedor na Meta**
   - Acesse: https://developers.facebook.com/
   - Crie um **App** (tipo "Business"). Ao final você terá:
     - `App ID`
     - `App Secret`
   - Este app é o que o ERP usa para publicar o catálogo (mesmo modelo do
     WhatsApp que já está no sistema).

5. **(Opcional / só se for tentar Marketplace de verdade)**
   - Solicitar acesso à **Marketplace Partner API**:
     https://developers.facebook.com/docs/marketplace/partnerships/sellerAPI/
   - Aprovação depende da Meta e **não é garantida** nem rápida. Não conte com
     isso para o prazo.

### Informações que o desenvolvedor vai precisar de você

- `App ID` e `App Secret` do app na Meta
- Acesso de admin ao Business Manager, à Página e ao Catálogo
- ID do Catálogo / da conta de Commerce

### Limitação importante (Facebook)

- Sem a Marketplace Partner API (invite-only), os produtos aparecem no
  **Facebook/Instagram Shops** via catálogo — não como anúncio de Marketplace.
- No Brasil o checkout é **fora da plataforma** (redireciona para o site), então
  **também não há webhook de pedido nem baixa de estoque automática**.

Links úteis:
- Business Manager: https://business.facebook.com/
- Commerce Manager: https://business.facebook.com/commerce/
- Meta for Developers: https://developers.facebook.com/
- Marketplace Partner API (parceiros): https://developers.facebook.com/docs/marketplace/partnerships/sellerAPI/

---

## 3. Resumo do que enviar ao desenvolvedor

| Plataforma | Credenciais | Observação |
|-----------|-------------|-----------|
| OLX | `client_id`, `client_secret`, scope `autoupload` | Exige plano Empresa; confirmar categoria autopeças |
| Facebook/Meta | `App ID`, `App Secret`, ID do Catálogo | Marketplace clássico só via parceiro aprovado |

**Expectativa realista:** nas duas plataformas dá para **publicar/atualizar
anúncios** a partir do ERP. A **baixa automática de estoque por venda** (como no
Mercado Livre/Shopee) **não é suportada** nem pela OLX nem pelo Facebook, porque
nenhuma das duas envia notificação de venda pela API para esse tipo de produto.
