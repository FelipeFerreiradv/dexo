# Teste local — OLX + Facebook

Branch `claude/olx-fb-paridade-total`. Dois comandos, dois terminais.

---

## ⚠️ Leia isto antes (30 segundos)

**O `.env` deste projeto aponta para o banco de PRODUÇÃO** (Supabase São Paulo,
`aws-0-sa-east-1`). E `npm run api` sobe **7 workers de fundo** que escrevem no banco e
chamam as APIs reais dos marketplaces: republicam anúncio, empurram estoque, varrem status.

**Não rode `npm run api` cru.** Use os scripts abaixo — eles setam
`BACKGROUND_WORKERS_DISABLED=1` antes de subir, e `dotenv` não sobrescreve variável já
definida no processo, então a trava vence o `.env` sem editar nenhum arquivo seu.

Você vai ver dados reais de produção (é o mesmo banco), mas **nada é escrito por worker** e,
no modo padrão, **nenhuma chamada sai para OLX ou Meta**.

---

## 1. Banco — corrigir o DDL

Seus três resultados têm **uma causa só**:

```
0.1 → ERROR 55P04: unsafe use of new value "OLX"
      HINT: New enum values must be committed before they can be used.
0.3 → ERROR 22P02: invalid input value for enum "Platform": "OLX"
```

O editor do Supabase envolve cada execução numa transação. No bloco 0.1, o
`SELECT unnest(enum_range(...))` **usava** o valor `'OLX'` na mesma transação que acabou de
criá-lo — o Postgres proíbe isso. O erro abortou a transação inteira, então **o enum não foi
gravado** e os `ALTER TABLE` daquele bloco também voltaram atrás. É por isso que o 0.3 falhou
depois: para o banco, `'OLX'` ainda não existe.

O 0.2 (colunas do `Product`) passou e **está aplicado** — não precisa repetir.

A correção é só separar em execuções. Rode **um bloco por vez**, na ordem.

### Passo 1 — só o enum. Rode isto sozinho e aguarde o "Success".

```sql
ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'OLX';
ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'FACEBOOK';
```

> Não coloque mais nada neste bloco. Nenhum `SELECT`, nenhum `UPDATE`, nenhum `ALTER TABLE`.
> Qualquer statement que mencione `'OLX'` ou `'FACEBOOK'` aqui derruba tudo de novo.

### Passo 2 — conferir + colunas (execução NOVA)

```sql
-- deve listar 5 linhas
SELECT unnest(enum_range(NULL::"Platform"));

ALTER TABLE "MarketplaceAccount"
  ADD COLUMN IF NOT EXISTS "olxSellerPhone"   TEXT,
  ADD COLUMN IF NOT EXISTS "olxSellerZipcode" TEXT,
  ADD COLUMN IF NOT EXISTS "fbCatalogId"      TEXT,
  ADD COLUMN IF NOT EXISTS "fbProductUrlBase" TEXT;

ALTER TABLE "ProductListing"
  ADD COLUMN IF NOT EXISTS "olxListId"           TEXT,
  ADD COLUMN IF NOT EXISTS "fbCatalogItemId"     TEXT,
  ADD COLUMN IF NOT EXISTS "olxCategoryOverride" TEXT,
  ADD COLUMN IF NOT EXISTS "fbCategoryOverride"  TEXT;
```

### Passo 3 — backfill do contato do vendedor OLX (execução NOVA)

Troque os dois valores pelos que estão no seu `.env` (`OLX_SELLER_PHONE` e
`OLX_SELLER_ZIPCODE`). Só faz efeito quando existir conta OLX conectada — hoje deve
retornar 0 linhas, e tudo bem.

```sql
UPDATE "MarketplaceAccount"
   SET "olxSellerPhone"   = COALESCE("olxSellerPhone",   '<OLX_SELLER_PHONE>'),
       "olxSellerZipcode" = COALESCE("olxSellerZipcode", '<OLX_SELLER_ZIPCODE>')
 WHERE platform = 'OLX';
```

### Passo 4 — conferência final (execução NOVA)

Se as três linhas voltarem `true`, o banco está pronto.

```sql
SELECT
  (SELECT count(*) FROM unnest(enum_range(NULL::"Platform")) v
    WHERE v::text IN ('OLX','FACEBOOK')) = 2                        AS enum_ok,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'ProductListing'
      AND column_name IN ('olxListId','fbCatalogItemId',
                          'olxCategoryOverride','fbCategoryOverride')) = 4 AS listing_ok,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'Product'
      AND column_name IN ('olxCategoryId','olxCategorySource','olxCategoryChosenAt',
                          'fbCategoryId','fbCategorySource','fbCategoryChosenAt')) = 6 AS product_ok;
```

---

## 2. Subir os servidores

**Terminal 1 — API:**

```bash
.\scripts\dev-local\api.ps1
```

**Terminal 2 — front:**

```bash
.\scripts\dev-local\web.ps1
```

Abra `http://localhost:3000`.

No terminal 1 você deve ver a linha
`[api] BACKGROUND_WORKERS_DISABLED=1 — nenhum worker de fundo iniciado`.
**Se essa linha não aparecer, pare tudo:** os workers subiram e vão mexer em produção.

### Os dois modos

| | Modo seguro (padrão) | Modo publicação (`-Publicar`) |
|---|---|---|
| UI de OLX/Facebook | completa | completa |
| **Conectar/desconectar conta** | **liberado** | liberado |
| Ler contas, salvar telefone/CEP | liberado | liberado |
| Publicar, sincronizar, importar | **bloqueado** | **real** |
| Serve para | tudo do §3 | só o §4 |

O kill-switch para de **mexer nos anúncios**, não de administrar a conta: dá para
conectar a OLX e o Facebook e deixar tudo configurado com a integração pausada. É o mesmo
que você vai querer em produção numa reautorização — sem precisar desligar a proteção.

Comece pelo seguro. Ele cobre os 11 primeiros testes.

---

## 3. Roteiro — modo seguro (sem chamada externa)

Marque conforme for passando.

### Visibilidade e ausência de regressão

- [ ] **T1** — Menu lateral mostra **OLX** e **Facebook** em Integrações.
      `http://localhost:3000/integracoes/olx` e `/integracoes/facebook` abrem (não dão 404).
- [ ] **T2** — Mercado Livre, Shopee e Magalu continuam **exatamente** como antes:
      abas, listagens e sincronizações intactas. *É o teste mais importante da lista.*
- [ ] **T3** — Aba de conexão da OLX abre sem banner de erro, e o botão
      **Conectar à OLX** funciona **no modo seguro** (conectar é configuração, não
      publicação). Depois de conectado, os campos **Telefone** e **CEP do vendedor**
      aparecem, salvam e persistem após recarregar. Idem no Facebook, com o **catálogo**.
- [ ] **T3b** — Ainda em modo seguro, clicar em **Sincronizar estoque** na aba de
      Sincronização devolve "Integração pausada". É o kill-switch fazendo o trabalho dele:
      conta conectada, publicação suspensa.

### Produtos e anúncios

- [ ] **T4** — Em Produtos, o filtro **por canal** lista OLX e Facebook, e selecionar cada
      um **não dá erro 400** (a listagem responde, mesmo que vazia).
- [ ] **T5** — Modal de **novo produto**: existem os toggles de OLX e Facebook, com seletor
      de categoria em cada um.
- [ ] **T6** — Modal de **edição de produto**: idem, e o texto de cada seção cita a
      plataforma certa (nada chamando OLX ou Facebook de "Shopee").
- [ ] **T7** — Modal de **edição de anúncio** de um item OLX/Facebook: aparece o campo de
      **categoria override**; salvar e reabrir mostra o valor salvo.

### Publicação em massa

- [ ] **T8** — Wizard de massa: selecionar **só** contas OLX (nenhuma Shopee) e avançar —
      o **preflight roda** (antes ele era pulado e o lote ia cego).
- [ ] **T9** — Modo **Revisão Individual**: cada produto mostra as abas de OLX e Facebook,
      com **"Valor do Anúncio (R$)"** em cada uma.
- [ ] **T10** — Ainda na Revisão Individual, **desmarque uma conta** OLX de um produto: o
      **total do lote diminui**. (Antes ele inflava e a barra de progresso travava.)
- [ ] **T11** — Preencha um "Valor do Anúncio" diferente para OLX e confira que a **prévia**
      mostra esse valor, não o preço do produto.

---

## 4. Roteiro — modo publicação (chamadas reais)

> Reinicie o terminal 1 com `.\scripts\dev-local\api.ps1 -Publicar`.
> **Use conta piloto.** Anúncio criado aqui é anúncio de verdade, com o telefone e o CEP
> que estiverem na conta.

- [ ] **T12** — Publicar 1 peça na OLX pelo modal de novo produto. Confere no painel da OLX.
- [ ] **T13** — Publicar 1 peça no Facebook. Confere no Commerce Manager.
- [ ] **T14** — Editar título e preço pelo modal de edição de anúncio → confirmar que mudou
      **no canal**, e que o Facebook fez **UPDATE** (o item não duplicou no catálogo).
- [ ] **T15** — Zerar o estoque da peça → o anúncio sai do ar nos dois canais.
- [ ] **T16** — 🔴 **O caso obrigatório.** Devolver o estoque para 1 (ou cancelar o pedido
      do ML, se a peça também estiver lá) → **os dois anúncios voltam ao ar**, com o
      **preço e a categoria corretos**, e o card mostra o link novo do anúncio da OLX.
- [ ] **T17** — Importar itens do catálogo Meta (`Integrações → Facebook → Importar`) →
      os produtos vêm com **estoque real e a galeria inteira**, não estoque 1 e uma foto.
- [ ] **T18** — Forçar uma recusa na OLX (ex.: preço muito baixo) → o card do anúncio mostra
      uma **mensagem em português** ("A OLX considerou o preço suspeito…"), não `statusCode -4`.

---

## 5. Se algo der errado

| Sintoma | Causa provável |
|---|---|
| `/integracoes/olx` dá 404 | subiu o front sem o script (as flags `NEXT_PUBLIC_*` são inlinadas no start) |
| Toda ação OLX/FB responde "desativado por kill-switch" | é o modo seguro funcionando — use `-Publicar` |
| Erro de coluna inexistente | faltou algum passo do §1; rode o **Passo 4** para ver o que falta |
| Mudei o código e a API responde igual | processo antigo pendurado na 3333. `Get-NetTCPConnection -LocalPort 3333 -State Listen` e `Stop-Process -Id <PID> -Force` |
| "Integração pausada" ao sincronizar/importar | correto em modo seguro. Conectar e configurar passam; publicar não |
| `invalid input value for enum "Platform"` | o **Passo 1** não commitou; rode-o sozinho de novo |
| Front chama produção | subiu o Next sem o script (`API_URL` do `.env` tem prioridade no server-side) |

Para conferir a suíte a qualquer momento:

```bash
NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --pool=forks
```

Esperado: **4.796 passando, 0 falhas**.
