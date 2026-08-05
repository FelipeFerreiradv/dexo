# Relatório final — 4 blocos (04/08/2026)

Branch `claude/production-system-4-blocks-03d7cd`. **Nada foi enviado (`push`)** —
os commits estão locais, como combinado.

---

## 0. Baseline e verificação

O worktree **não tinha `node_modules`** (nem o repo main: só `.cache`), então
nenhum comando de verificação rodava. `npm ci` + `prisma generate` foi o passo
zero. Só depois disso os números abaixo passaram a existir.

| Gate                                 | Baseline                           | Final                              |
| ------------------------------------ | ---------------------------------- | ---------------------------------- |
| `tsc --noEmit \| grep -c "error TS"` | **100**                            | **100**                            |
| `next lint`                          | 0 erros, 14 warnings               | 0 erros, 14 warnings               |
| `vitest run --pool=forks`            | 4026 passed / 27 skip / **0 fail** | **4134 passed / 27 skip / 0 fail** |
| `npm run build`                      | —                                  | verde (exige `DATABASE_URL` dummy) |

Os 108 testes a mais são exatamente os novos: 42 (Bloco 1) + 23 (Bloco 2) +
43 (Blocos 3 e 4). **Nenhuma falha nova** — o critério de regressão do repo.

Os 2 erros de TypeScript que citam `create-product-dialog.tsx` são
**pré-existentes** (`Property 'confidence' does not exist...`, linhas 2247/2253
no baseline); apenas deslocaram de linha.

`next lint` não roda direto no worktree aninhado: o ESLint sobe a árvore e acha o
`.eslintrc.json` do repo main, que não consegue resolver `next` porque o main não
tem `node_modules`. O gate real usado foi
`npx eslint --no-eslintrc -c .eslintrc.json` com globs (ESLint 9 não aceita
diretórios).

---

## 1. Bloco 1 — Ordem das etiquetas · commit `d0193f1`

### Causa-raiz provada (e o que o enunciado supunha errado)

**Não era bug de pipeline.** Levantamento com leitura dos 4 pontos de geração:

- **não existe um único `.reverse()` em todo `app/`**;
- nenhum dos 4 geradores reordena — todos iteram `forEach`/`for` na ordem recebida;
- o `Promise.all` de `shipping-label.usecase.ts:444` **não é um bug**: é um worker
  pool com escrita indexada (`results[i] = raw`), e o `Promise.all` é sobre os
  _workers_, não sobre os resultados. A ordem já era preservada.

O PDF saía **exatamente na ordem da tela**, e a tela é
`ORDER BY (stock > 0) DESC, "createdAt" DESC` — mais novo primeiro. Cadastrou
1..10, vê 10..1, imprime 10..1.

Os defeitos reais eram dois `filter` que descartavam a ordem de clique:
`products-list.tsx:1158` e `locations-list.tsx:1051`. A ordem de seleção já
existia nos dois (`Set` preserva inserção); só não era consumida.

> Correção ao enunciado: `product.repository.ts:1407` é o `catch` de fallback do
> `findAll`, e `:1689` é `stockLog.findMany` (histórico de estoque). O ordenador
> real é SQL bruto em `:1363`.

### O que mudou

- **novo** `app/lib/label-order.ts` — `orderBySelection()` em **O(n+m)** (o
  `filter` + `includes` anterior era O(n·m)) e `selectAllIdsInPrintOrder()`.
- `products-list.tsx` e `locations-list.tsx` passam a consumir a ordem de seleção.
- **"Selecionar todos" insere de baixo para cima.** A lista **não tem controle de
  ordenação** (grep por `sortBy|orderBy|sort=` retorna zero em `products-list.tsx`
  e em `product.routes.ts`), então respeitar só a ordem de clique deixaria o caso
  mais comum — selecionar tudo e imprimir — saindo 10..1, que é a queixa. Com a
  lista newest-first, inserir de baixo para cima entrega o mais antigo primeiro.
- Etiqueta avulsa e etiqueta de envio em lote **não mudaram** — já estavam
  corretas. Ganharam teste de regressão.

**Efeito colateral assumido:** quando a seleção vem de "selecionar todos",
exclusão e pausa em massa percorrem os ids na ordem inversa. O resultado é
idêntico (ambas são operações independentes por id); muda só a ordem das chamadas
e do relatório de falhas. Está atrás do mesmo kill-switch.

### Testes (42)

Helper (ordem de seleção, id ausente, lista vazia, 1 item, 5.000 itens medindo
linearidade) · fluxo de produto (3,1,2 → PDF 3,1,2; desmarcar/remarcar move para o
fim; poda por página preserva a ordem) · localização · avulsa com `quantity>1` ·
**lote de envio com latências invertidas** (o teste que pegaria um `Promise.all`
consumido fora de ordem) · flag ligada reproduz a ordem de hoje.

---

## 2. Bloco 2 — Precisão da sugestão de categoria · commit `50190a5`

### A régua veio primeiro

**novo** `scripts/eval-category-suggestion.ts`, read-only, rodado contra
produção. Ele existe porque o `validate-category-inference.ts` usa como gabarito
_qualquer_ produto com categoria preenchida — inclusive as que a própria sugestão
preencheu, ou seja, mede em parte o sistema concordando consigo mesmo.

**Gabarito medido no banco:** `*Source` é `String` livre, não enum.

| Coluna                 | Valores reais                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `mlCategorySource`     | IMPORT_RESOLVED 10.406 · auto 5.226 · null 4.899 · ml-orphan-import 3.322 · **manual 1.598** · auto_discovery 353 |
| `shopeeCategorySource` | manual 6.022 · auto_discovery 50                                                                                  |
| `magaluCategorySource` | manual 577                                                                                                        |

Só o ML distingue de verdade. Na Shopee e na Magalu o front gravava `"manual"`
também quando a sugestão automática era apenas **aceita passivamente** — logo
"manual" ali não significa humano. **Isso foi corrigido** (seção abaixo).

Ressalva registrada no próprio script: no conjunto ML, "top-1 exato" quase zero é
em boa parte **definicional** — o front só grava `"manual"` quando a escolha final
difere da auto-detectada. As métricas sem esse viés são **"mesmo ramo"**, top-3/5
e **auto-aplicação divergente**.

### A causa-raiz encontrada

A coluna `CategoryAlias.tokens` foi populada com o **título inteiro** do anúncio
de origem, veículo incluído:

```
tokens="acabamento,retrovisor,direito,volvo,v40,2014,1287712,pecas,de,interior,..."
```

Consequência: `volkswagen`, `fox`, `2011`, `2012` entravam como token de **peça**
(+2 cada = 8 pontos) **e ainda** somavam marca (+3) e modelo (+2) pelo
`brandModelPatterns` — o mesmo veículo contado duas vezes, sem o tipo de peça
precisar casar uma única vez. Seis pontos de veículo batiam os dois pontos de um
token de tipo correto.

Medido em produção com `"Retrovisor Direito Volkswagen fox 2011 2012"`: **cinco
categorias empatavam em score 13** — Fechaduras de Portas, Grades de Faróis de
Milha, Reservatório do Radiador, Carroceria > Outros —, todas com confiança 0,95 e
**todas auto-aplicadas**. Nenhuma tinha relação com retrovisor. O mesmo título
**sem** marca/modelo/ano acertava.

> Quanto mais contexto o usuário dava, pior ficava a sugestão.

### Resultado (n=533 ML com gabarito humano, n=600 Shopee)

| Métrica                     | Antes         | Depois        | Δ                     |
| --------------------------- | ------------- | ------------- | --------------------- |
| ML top-1 exato              | 0,6%          | **8,1%**      | +40 casos             |
| ML top-3                    | 2,8%          | **10,3%**     | +40                   |
| ML top-5                    | 4,3%          | **10,7%**     | +34                   |
| ML **mesmo ramo**           | 6,2%          | **15,9%**     | +52                   |
| ML **auto-aplicado ERRADO** | 467           | **164**       | **−65%**              |
| ML só-folha top-1 (n=366)   | 0,8%          | **11,7%**     | +40                   |
| Shopee top-1                | 76,0%         | 76,0%         | **0 (sem regressão)** |
| Shopee top-3 / top-5        | 78,3% / 78,7% | 78,5% / 79,0% | +1 / +2               |

**Zero casos que acertavam passaram a errar. 40 erros viraram acertos.**
Latência ML p50/p95: 168/263 ms → dentro do orçamento de 3 s já existente.

### Delta por técnica (medido uma a uma)

| Técnica                                 | ML top-1 | ML mesmo ramo | ML autoApply errado | Shopee top-1 | Decisão        |
| --------------------------------------- | -------- | ------------- | ------------------- | ------------ | -------------- |
| baseline                                | 0,0%     | 6,0%          | 346                 | 73,3%        | —              |
| contexto como **token livre**           | 2,0%     | 9,5%          | 373                 | **34,0%**    | **DESCARTADA** |
| contexto **estruturado**                | 0,5%     | 5,8%          | 382                 | 73,3%        | mantida        |
| normalização v2 (plural/abrev/stopword) | 0,5%     | 5,5%          | 383                 | 72,8%        | **DESCARTADA** |
| **evidência de peça** (a correção)      | 8,3%     | 15,8%         | 292                 | 73,3%        | mantida        |
| + coerência de qualificador             | 8,8%     | 16,0%         | 281                 | 73,3%        | mantida        |
| + calibragem do auto-aplicar            | 8,8%     | 16,0%         | **167**             | 73,3%        | mantida        |

O código das duas técnicas descartadas foi **removido**, não deixado atrás de
flag.

### Outras entregas do bloco

- `suggestFromProduct(ctx, siteId)` novo; `suggestFromTitle` delega e continua
  idêntico (provado por teste). Chave de cache ganha sufixo **só quando há
  contexto** — sem contexto continua sendo exatamente `${siteId}::${titulo}`.
- Rotas `POST /ml/category-suggest` e `POST /shopee/category-suggest` — aditivas;
  os `GET` seguem intactos.
- `create-product-dialog.tsx` passa a enviar o contexto que já tinha em mãos.
- **Correção da gravação de `*Source`** para Shopee e Magalu, usando a mesma
  técnica do ML. Muda só o valor da coluna — nada lê esse campo para decidir
  comportamento (verificado). É o que torna possível medir precisão daqui pra
  frente.

---

## 3. Blocos 3 e 4 — Histórico e rascunho do modal

### Histórico "Cadastros recentes"

Os 5 últimos cadastros **submetidos com sucesso** ficam disponíveis no topo do
modal, ao lado do `InternalSuggestionPicker` e com o mesmo vocabulário visual.
Aplica reusando `suggestion-merge.ts`: **preenche só o que está vazio**, merge não
destrutivo de `attributes`, união de `compatibilities`, conflito informado no
toast em vez de sobrescrever.

**Nunca copiados:** `sku`, `partNumber`, `imageUrl`/`imageUrls`, `stock`, `name`,
`price`/`costPrice`/`markup`, `mlCatalogProductId`, `scrapId`.

**Fonte = snapshot do formulário, não o banco.** O `Product` não guarda contas de
marketplace selecionadas, tipo de anúncio, garantia, modo de envio, tempo de
fabricação, atributos dinâmicos do ML nem as compatibilidades editadas na hora.
Reconstituir isso exigiria juntar `Product` + `ProductListing` +
`ProductCompatibility` + contas, e ainda viria incompleto.

### Rascunho automático

Autosave com debounce de 600 ms; na reabertura, um `AlertDialog` pergunta
"Continuar de onde parou?" com **[Continuar]** e **[Descartar rascunho]**.
Restaura RHF + compatibilidades + ficha técnica + contas + seção. TTL de 24 h e
versão de payload: expirado ou desconhecido some **sem perguntar nada**. Limpo no
submit bem-sucedido e no descarte.

### O ponto de regressão mais perigoso

`onSubmit` decide entre `autoSku: true` e SKU manual comparando o campo com
`autoSuggestedSkuRef`, que é repovoado a cada abertura. **Restaurar um SKU antigo
faria o submit tomar o caminho manual e enviar um código que outro cadastro já
podia ter consumido.** Por isso `sku` não entra no snapshot em nenhum dos dois
fluxos — só como rótulo de exibição — e há teste de contrato do payload.

### Escopo e isolamento

Chaves escopadas por **dono do dado** (`parentUserId ?? id`, espelhando o
`dataOwnerId` do backend) **e** por contexto de abertura (`manual` / `nfe` /
`scrap`). Nenhuma chave de `localStorage` do repo era escopada por usuário até
agora — esta é a primeira, e precisa ser.

### Desvio assumido

Os Blocos 3 e 4 vieram **num commit só**. Eles compartilham o serializador (como o
próprio enunciado pediu) e se integram na mesma região do mesmo arquivo de 5.100
linhas; separá-los exigiria um commit intermediário que não compila. O que o rito
protege continua valendo: cada feature tem seu próprio kill-switch e pode ser
desligada sem tocar na outra.

---

## 4. Flags novas

| Flag                                   | Valor que restaura o comportamento anterior | Camada             |
| -------------------------------------- | ------------------------------------------- | ------------------ |
| `NEXT_PUBLIC_LABELS_ORDER_LEGACY`      | `1`                                         | front (build-time) |
| `CATEGORY_SUGGEST_V2_DISABLED`         | `1`                                         | servidor (runtime) |
| `NEXT_PUBLIC_PRODUCT_HISTORY_DISABLED` | `1`                                         | front (build-time) |
| `NEXT_PUBLIC_PRODUCT_DRAFT_DISABLED`   | `1`                                         | front (build-time) |

Todas documentadas no `.env.example`, com o defeito que corrigem e os números.

> Observação: `CATEGORY_INFERENCE_DISABLED`, citada no enunciado como padrão do
> repo, **não estava documentada** no `.env.example` (só lida no código).

---

## 5. Performance

| Item                            | Antes                                  | Depois                                                                   |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| Seleção → PDF de etiquetas      | O(n·m) (`includes` dentro de `filter`) | **O(n+m)** (`Map` + um passe)                                            |
| Sugestão de categoria (ML)      | p50 168 ms / p95 263 ms                | p50 168 ms / p95 263 ms (inalterada)                                     |
| Escritas do autosave            | —                                      | **1 por rajada** de digitação (debounce 600 ms, provado com fake timers) |
| Re-render do modal por autosave | —                                      | **nenhum** (`watch(cb)` + callback estabilizado por ref)                 |

O `saveDraftNow` precisou ser estabilizado por ref: sem isso a assinatura do
`watch` se re-inscreveria a cada tecla, porque o hook devolve um objeto novo a
cada render.

---

## 6. O que ficou de fora, e por quê

- **`edit-product-dialog.tsx` e `bulk-review` continuam no `GET` (só título).** A
  medição isolada mostrou que o contexto estruturado sozinho vale +2 acertos em
  400; o ganho real do bloco veio da correção de evidência de peça, que beneficia
  **todos** os chamadores independentemente de contexto. Em `bulk-review` ainda
  seria preciso alargar `ReviewProduct` (`per-product-types.ts:78-87`), que hoje
  só tem 8 campos. Baixo valor medido, custo real.
- **Preditor nativo do ML (`domain_discovery`) como voto** — não entrou. Com a
  causa-raiz corrigida, o ganho marginal precisa ser medido antes, e ele adiciona
  uma chamada de rede no caminho do modal.
- **Shopee: não há preditor nativo integrado** e `scripts/probe-shopee-suggestion.ts`
  **não existe** (assim como `auto-categorize-products.ts` e
  `categorize-failures.ts`, também citados no enunciado). Sondar a API nativa
  exige IP na whitelist, ou seja, rodar da VPS.
- **Teste de interação do modal** (clicar, fechar, reabrir): a suíte não tem jsdom
  nem `@testing-library/react` e você optou por não adicionar dependência. Toda a
  lógica foi extraída para módulos puros e testada lá; o clique real permanece sem
  cobertura automática.

---

## 7. Riscos da Fase 0, revisitados

| #   | Risco                                                | Como ficou                                                                   |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| R1  | SKU restaurado → `autoSku:false` → colisão           | `sku` fora do snapshot + teste de contrato do payload                        |
| R2  | Histórico/rascunho sobre NF-e ou sucata              | chave separada por contexto + política "só preenche vazio"; testado          |
| R3  | `fetchDefaultDescription` sobrescrever o restaurado  | restauração é disparada pela pergunta, depois dos fetches de abertura        |
| R4  | Auto-fill por título sobrescrever campo restaurado   | `autoDetectedRef` é `null` pós-abertura → só preenche vazio                  |
| R5  | Vazamento entre tenants no navegador                 | chave por `parentUserId ?? id`; testado                                      |
| R6  | Autosave re-renderizando a cada tecla                | `watch(cb)` + ref estável + debounce; testado                                |
| R7  | `handleOpenChange` chama `setOpen(false)` duas vezes | nenhuma lógica de rascunho foi posta em `setOpen`                            |
| R8  | `localStorage` bloqueado/cheio                       | `try/catch` em tudo; testado com storage que explode na leitura e na escrita |
| R9  | Cache "grudar" o primeiro resultado                  | chave ganha sufixo só quando há contexto; testado                            |
| R10 | Preditor nativo lento travar o modal                 | não foi integrado                                                            |

---

## 8. Para repassar ao cliente

**Etiquetas.** O PDF agora sai na ordem em que você seleciona: o primeiro item
marcado é a primeira etiqueta. Usando "selecionar todos", as etiquetas saem do
cadastro mais antigo para o mais novo — a ordem crescente que você espera na hora
de imprimir e organizar. Vale para etiquetas de produto e de localização; etiqueta
avulsa e etiqueta de envio já saíam certas.

**Sugestão de categoria.** Havia um defeito em que a marca, o modelo e o ano do
veículo pesavam mais do que o próprio tipo de peça. Na prática, "Retrovisor
Direito Volkswagen Fox 2011" era classificado como "Fechadura de Porta" — e com
confiança alta o bastante para ser aplicado sozinho. Corrigido: o tipo de peça
manda, e marca/modelo/ano só entram como desempate. Medindo contra categorias que
sua equipe escolheu à mão, os acertos subiram de 0,6% para 8,1%, os acertos no
mesmo grupo de categorias de 6,2% para 15,9%, e as categorias aplicadas
automaticamente de forma errada caíram 65%.

**Cadastro em sequência.** Ao cadastrar várias peças parecidas, o modal agora
oferece os 5 últimos cadastros para reaproveitar. Ele preenche apenas os campos
que estão vazios e nunca copia SKU, part number, fotos, estoque, nome ou preço.

**Nada mais se perde.** Se o modal fechar sem querer, o preenchimento fica salvo e
ao reabrir o sistema pergunta se você quer continuar de onde parou.

---

## 9. Recomendações

**Barato e vale a pena**

1. **Rodar `npm run map:part-type-categories`** e repopular `CategoryAlias.tokens`
   sem os tokens de veículo. A correção deste bloco neutraliza o dado sujo em
   tempo de consulta; limpar a origem melhora tudo que consome a tabela.
2. **10.232 dos 19.485 aliases do ML apontam para um GALHO, não para uma folha.**
   `ensureLeafLocal` então desce para "Outros" ou para o **primeiro filho** —
   escolha arbitrária. É a próxima maior fonte de erro depois desta.
3. Rodar a régua periodicamente agora que `*Source` distingue humano de máquina.

**Grande e precisa de decisão**

4. **Controle de ordenação na lista de produtos** (SKU, cadastro, asc/desc).
   Resolveria a ordem das etiquetas de forma geral, em vez da convenção
   "selecionar todos = de baixo para cima".
5. **Preditor nativo do ML como voto** na sugestão, com timeout e fail-open.
6. **jsdom + `@testing-library/react`** para cobrir interação de modal.
7. Endpoint de "últimos produtos do tenant" como complemento do histórico, para
   quem troca de máquina.
