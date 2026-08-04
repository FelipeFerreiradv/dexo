# Incidente 29/07/2026 — Shopee `upload_invoice_doc` 404 mascarado por HTTP 500

| | |
|---|---|
| **Data do incidente** | 29/07/2026, ~14:06 (America/Sao_Paulo) |
| **Cliente** | `comerciodlsautopeca@gmail.com` (shop Shopee `1322438439`) |
| **Pedido** | `2607290P63B8P8` — id interno `cms68qmdk027818ysnfn3hfbf`, R$ 925,00, `SHIPPED` |
| **Sintoma** | `POST /orders/:id/shipping-label` → HTTP 500; UI exibia `Shopee upload_invoice_doc 404: Request failed with status code 404` |
| **Investigado em** | 04/08/2026, contra a API de produção da Shopee |
| **Branch** | `claude/shopee-upload-invoice-doc-404-05da34` |

---

## 1. Causa raiz

> **`ShopeeApiService.uploadInvoiceDoc` chamava `/api/v2/logistics/upload_invoice_doc`, mas esse
> endpoint pertence ao módulo `order` da Shopee Open Platform v2. O gateway responde
> `HTTP 404 {"error":"error_not_found"}` a uma rota que não existe.**

A prova é um A/B contra a API real de produção: mesma assinatura HMAC, mesmo corpo multipart,
mesmo pedido, mesmo token — mudando **apenas o segmento de módulo do path**.

```text
POST https://partner.shopeemobile.com/api/v2/logistics/upload_invoice_doc
     ?partner_id=***&timestamp=1785875643&access_token=***&shop_id=1322438439&sign=***
  multipart: order_sn=2607290P63B8P8, file_type=normal_invoice, file=6663 bytes (XML)

  ← HTTP 404  (951 ms)
  {
    "error": "error_not_found"
  }
```

```text
POST https://partner.shopeemobile.com/api/v2/order/upload_invoice_doc
     ?partner_id=***&timestamp=1785875644&access_token=***&shop_id=1322438439&sign=***
  multipart: order_sn=2607290P63B8P8, file_type=normal_invoice, file=6663 bytes (XML)

  ← HTTP 200  (605 ms)
  {
    "error": "error_param",
    "message": "Wrong parameters, detail: parameter type error, normal_invoice can not be parsed to integer.",
    "request_id": "e3e3e7f3583e937105e519938ab7ca00:0100035ef390b1e0:000000d763b67861"
  }
```

O segundo já chega à lógica de negócio (tem `request_id`), o primeiro nem existe como rota.

**Por que o 404 virou uma mensagem inútil.** O corpo do 404 traz `error`, mas **não traz
`message`**. O catch lia exatamente e somente `message`:

```ts
const message = (error.response?.data as { message?: string })?.message || error.message;
throw new Error(`Shopee upload_invoice_doc ${status ?? ""}: ${message}`);
```

Com `message` ausente, caía no `error.message` do axios — `"Request failed with status code 404"`.
O dado que resolvia o caso (`error_not_found`) estava no objeto e era descartado uma linha antes.

**Por que virou 500.** O erro era um `Error` puro, não um `ShippingLabelError`, então escapava do
mapa `shippingErrorStatus` (que já previa `PROVIDER_ERROR → 502`) e caía no catch genérico da rota.

**Não foi regressão.** `git log -S "upload_invoice_doc"` retorna só dois commits, ambos de
**24/06/2026** (`080bc61`, `ad23a78` — "adapter Shopee (logistics) — Fase 4"). O path nasceu errado
e nunca mudou: **a emissão de etiqueta Shopee nunca funcionou**. O próprio código admitia não ter
sido validado ("Shapes a confirmar em homologação"). O que aconteceu em 29/07 foi o conserto da
ingestão de pedidos Shopee, que fez muito mais pedido virar `Order` elegível a etiqueta — o defeito
saiu da sombra. **Exposição, não introdução.**

### Defeito nº 2, achado durante a investigação

O A/B revelou que, mesmo no path certo, o `file_type` estava errado: a Shopee exige **inteiro**, e
mandávamos a string `"normal_invoice"`. Varrendo `0..5` e `99` contra produção, **apenas `4`** passa
da validação de arquivo e alcança a regra de negócio; os demais param em
`order.upload_invoice_error` "File error." e `0` é lido como ausente.

O mesmo processo empírico fixou o resto do contrato:

| Variável | Valor correto | Como foi provado |
|---|---|---|
| Módulo | `order` | `logistics` → 404 `error_not_found` |
| Corpo | `multipart/form-data` | JSON+base64 → `"field file_type type error"` |
| Campo do arquivo | `file` | `invoice_file` → `"file is a required field"` |
| `file_type` | inteiro `4` | string → `"can not be parsed to integer"`; 1/2/3/5/99 → "File error." |

### Defeito nº 3 — regra de negócio que prende o pedido

Com tudo correto, o pedido do incidente responde:

```json
{
  "error": "error_param",
  "message": "Wrong parameters, detail: Upload invoice failed. Upload is not accepted after shipment is arranged.",
  "request_id": "e3e3e7f3583ea5ece31a07d3511b3300:010003afbba0eb07:000000f3c52e26dc"
}
```

A Shopee **recusa o upload da NF-e depois que o envio foi arranjado**. Como o pipeline abortava
nessa etapa, qualquer pedido nessa situação ficava permanentemente sem etiqueta.

### ⚠️ Ponto NÃO CONFIRMADO

`open.shopee.com` bloqueia acesso automatizado; a confirmação do módulo veio do
[shopee-sdk](https://github.com/congminh1254/shopee-sdk) (cobertura declarada de 100% dos endpoints
v2, `upload_invoice_doc` sob `order`, `module=94`; os 46 endpoints de `logistics` não incluem
nenhum de invoice) mais o A/B acima, que é definitivo.

**O que permanece sem confirmação:** o significado nominal do `file_type = 4` e se ele espera o
**XML autorizado** ou o **PDF do DANFE**. Os dois payloads chegam ao mesmo ponto porque a regra
"shipment arranged" responde antes da validação de conteúdo, e **os 5 pedidos Shopee com NF-e
autorizada da base já estavam despachados**. Mantivemos o XML, que é o que o código sempre enviou.
Fechar isso exige o **próximo pedido Shopee ainda não despachado** — está anotado em
`SHOPEE_INVOICE_FILE_TYPE_NFE` (`shopee-constants.ts`).

---

## 2. Arquivos alterados

| Arquivo | Por quê |
|---|---|
| `app/marketplaces/shopee/shopee-constants.ts` | **Causa raiz.** Paths viram constantes **agrupadas pelo módulo real**, para "endpoint no módulo errado" ficar visível na revisão. `SHOPEE_INVOICE_FILE_TYPE_NFE = 4`, documentado com a evidência. |
| `app/marketplaces/services/shopee-api.service.ts` | `uploadInvoiceDoc` no path certo, `file_type` inteiro, catch que **preserva** corpo/código/`request_id`. `buildSignedUrl` passa a tirar a query antes de assinar. `download_shipping_document` deixa de duplicar `shipping_document_type` e detecta JSON de erro travestido de PDF. Novo `getShippingDocumentParameter`. |
| `app/marketplaces/shipping/integration-error.ts` | **Novo.** `MarketplaceIntegrationError` + `toIntegrationError`/`integrationErrorFromBody` + `toUserFacingMessage`. Ponto único de normalização; espelha o `mlError` do ML. |
| `app/marketplaces/services/shopee-shipping.service.ts` | Tolera "upload not accepted after shipment is arranged" (espelha `invoiceAlreadyHandled` do ML) e consulta o tipo de documento aceito antes de gerar. |
| `app/marketplaces/shipping/auth-retry.ts` | `withTransientRetry` (backoff + jitter) e `isTransientProviderError`, aplicados a **ML, Shopee e Magalu**. |
| `app/marketplaces/usecases/shipping-label.usecase.ts` | Lock por pedido, orçamento de tempo, pré-checagem do XML, log estruturado e conversão para `PROVIDER_ERROR`. Comentário obsoleto sobre o mutex da Shopee corrigido. |
| `app/routes/order.routes.ts` | Payload de erro estável com `correlationId` (aditivo). |
| `app/marketplaces/services/shopee-oauth.service.ts` | `SHOPEE_DEBUG=1` deixa de logar o `access_token` em texto plano. |
| `lib/shipping-label-error.ts` | **Novo.** Formata o erro na UI e barra texto cru de cliente HTTP. |
| `app/pedidos/components/{order-detail-sheet,orders-list}.tsx` | Usam o formatador; some a inconsistência `message` vs `error` entre detalhe e lote. |
| `next.config.ts` | CSP `img-src` + CDNs de imagem da Shopee. |
| `scripts/repro-shipping-label.ts` | **Novo.** Reprodução sem UI, com A/B de módulo e mascaramento de segredos. |
| `vitest.config.ts`, `.env.example` | Kill-switches; documenta `SHOPEE_PARTNER_*`, `FISCAL_STORAGE_PATH`, `SHIPPING_STORAGE_PATH`, que não constavam. |
| 3 specs novos + 1 corrigido | Ver seção 8. |

---

## 3. Fluxo antigo

```
UI "Emitir etiqueta"
  └─ POST /orders/:id/shipping-label
       └─ generateLabelForOrder                        (sem lock: 2 cliques = 2 pipelines)
            ├─ resolveContext                          valida NF-e e LÊ o XML  ✓
            └─ produceRawLabel                         (sem orçamento de tempo)
                 ├─ ensureInvoiceSent
                 │    └─ uploadInvoiceDoc
                 │         └─ POST /api/v2/LOGISTICS/upload_invoice_doc   ✗ 404
                 │              catch: lê data.message (ausente)
                 │                     → "Request failed with status code 404"
                 │                     ✗ descarta error, request_id, headers, URL
                 │              (Error puro, sem tipo)
                 ├─ ensureReadyToShip                  ← nunca alcançado
                 └─ getLabelPdf                        ← nunca alcançado
       catch da rota: não é ShippingLabelError → HTTP 500 opaco
  UI: setLabelError(data.message)  →  texto técnico cru na tela
```

## 4. Fluxo novo

```
UI "Emitir etiqueta"
  └─ POST /orders/:id/shipping-label
       └─ generateLabelForOrder
            └─ [NOVO] lock por orderId ─── 2º concorrente espera e reusa (reused:true)
                 ├─ resolveContext
                 │    ├─ valida NF-e (produção, modelo 55, XML presente)
                 │    └─ [NOVO] pré-checa conteúdo: não vazio e começa com "<"
                 └─ produceRawLabel   [NOVO] orçamento de tempo entre etapas (90s)
                      ├─ ensureInvoiceSent
                      │    └─ uploadInvoiceDoc
                      │         └─ POST /api/v2/ORDER/upload_invoice_doc  ✓
                      │              file_type=4 (inteiro), campo `file`
                      │              [NOVO] 200-com-error também é falha
                      │              [NOVO] toIntegrationError preserva
                      │                     error, message, request_id, endpoint (sanitizado)
                      │         [NOVO] retry só de transitório (429/5xx/rede), backoff+jitter
                      │    [NOVO] "not accepted after shipment is arranged" → segue em frente
                      ├─ ensureReadyToShip
                      └─ getLabelPdf
                           ├─ [NOVO] get_shipping_document_parameter → tipo aceito
                           ├─ create → poll → download
                           └─ [NOVO] resposta não-PDF vira erro tipado
            catch: MarketplaceIntegrationError
                   → log estruturado (sem segredo/PII)
                   → ShippingLabelError("PROVIDER_ERROR") → HTTP 502
  UI: formatLabelError → "Falha ao enviar a NF-e do pedido 2607290P63B8P8 na Shopee: …"
```

---

## 5. Justificativa técnica

- **Constantes por módulo** em vez de string solta: o defeito foi escrever um path "por analogia
  com os vizinhos". Agrupar por módulo real transforma isso em erro visível na revisão.
- **Um normalizador só** (`toIntegrationError`): havia três formatos de catch (ML preservava
  `responseData`, Magalu também, Shopee não). Unificar pelo comportamento do ML segue a regra da
  casa de espelhar o Mercado Livre.
- **`PROVIDER_ERROR` → 502**: o mapa já existia e nunca era alcançado porque o adapter não
  embrulhava. 500 passa a significar só "inesperado de verdade".
- **Retry no `ShippingAuthRetry`**, não em volta do pipeline: retentar `produceRawLabel` refaria
  `ship_order` e criaria envio duplicado. A granularidade certa é a chamada HTTP.
- **Classificador conservador**: erro sem classificação **não** é retentado. Retentar o 404 teria
  sido a "correção" errada — nenhuma tentativa extra acha uma rota que não existe.
- **Tolerar "shipment arranged"** em vez de falhar: a etapa fiscal deixou de se aplicar; insistir
  nunca passa. Mesma lógica do `invoiceAlreadyHandled` do ML.
- **Kill-switches**: cada mudança de comportamento é revertível por env, ligada em produção e
  desligada na suíte — que é como os specs anteriores continuam byte-idênticos.

---

## 6. Como a correção evita novas ocorrências

**Falha rápido:** XML vazio/inválido barra antes da rede; config da Shopee ausente ou
`PARTNER_KEY` com tamanho errado aborta na inicialização; orçamento de tempo corta antes do proxy;
tipo de etiqueta não suportado é detectado antes do `create`.

**Ficou observável:** todo erro de integração carrega `marketplace`, `operation`, `endpoint`
(sanitizado), `httpStatus`, `providerErrorCode`, `providerMessage`, `providerRequestId`,
`responseBodySnippet`, `orderId`, `orderSn`, `shopId`, `step` e `correlationId`, com `cause`
preservado. O `correlationId` volta no corpo da resposta, então o print do lojista já casa com o
log. O `request_id` da Shopee — que o suporte deles pede — deixou de ser descartado.

**Ficou travado por teste:** um snapshot afirma host + path + params da URL final. Trocar o módulo
de novo quebra o build.

---

## 7. Cenários adicionais protegidos

- Dois cliques ou duas abas no mesmo pedido → um pipeline só.
- 5xx/429/queda de rede passageira da Shopee → retry com backoff em vez de falha definitiva.
- 4xx determinístico → falha imediata, sem multiplicar chamadas.
- `HTTP 200` com `{"error": …}` → tratado como falha (antes, `downloadShippingDocument` podia
  gravar o JSON de erro em disco como se fosse a etiqueta).
- XML gravado como JSON (bug conhecido do `buscarXml`) → mensagem clara, sem chamar a Shopee.
- Transportadora que não aceita A4 → usa o tipo sugerido em vez de falhar.
- `SHOPEE_DEBUG=1` deixa de vazar `access_token` no stdout do pm2.

---

## 8. Testes

**Novos** — todos falham no código anterior:

- `app/marketplaces/services/__tests__/shopee-upload-invoice-doc.spec.ts` (10): módulo `order`;
  snapshot da URL; `file_type` inteiro e campo `file`; 404 → erro tipado sem "Request failed with
  status code"; 200-com-`error_param` é falha; `request_id` preservado; **segredos ausentes** de
  mensagem, `endpoint` e log; classificação transitório × determinístico; `download` sem campo
  duplicado; JSON travestido de PDF.
- `app/marketplaces/shipping/__tests__/shipping-label-resilience.spec.ts` (22):
  `PROVIDER_ERROR` (→502) com mensagem legível; pré-checagem do XML (vazio, JSON, válido); lock
  (concorrência e falha do primeiro); retry (classificação, 5xx retenta, 404 não, kill-switch);
  tolerância ao "shipment arranged"; `get_shipping_document_parameter`; orçamento de tempo.
- `tests/shipping-label-error-format.spec.ts` (5): a UI nunca exibe texto cru de cliente HTTP.

**Corrigido:** `shopee-shipping.service.spec.ts:240` afirmava
`toContain("/api/v2/logistics/upload_invoice_doc")` — congelava a suposição em vez do contrato.

**Prova de que pegam o defeito:** revertendo o path e o `file_type` no código,
**4 dos 10 testes falham**; restaurados, 10/10 passam.

**Suíte completa:** `383 arquivos passaram / 2 skipped`, `4015 testes passaram / 27 skipped`,
**0 falhas** (`vitest run --pool=forks`, exit 0).
> O pool padrão (`threads`) segfalha nesta máquina Windows **antes e depois** das mudanças —
> verificado removendo os specs novos. É pré-existente e não relacionado.

**Manual, contra produção:** ver seção 10.

---

## 9. Riscos analisados

| Risco | Mitigação |
|---|---|
| `file_type = 4` foi determinado empiricamente, não pela doc | Isolado numa constante documentada. Se estiver errado, o erro agora é **legível** (`error_param` com a mensagem da Shopee) em vez de opaco. |
| Não se sabe se o tipo 4 quer XML ou PDF | Mantido o XML — comportamento inalterado. Trocar sem prova seria mudança não fundamentada. |
| Retry novo em código compartilhado | Só transitório; erro não classificado nunca retenta; kill-switch; specs de ML/Magalu inalterados. |
| Lock é por processo | A API roda como instância única no pm2 (`dexo-api`, fork). Com múltiplas instâncias, a idempotência por `ShipmentLabel` continua sendo a rede de proteção. Documentado no código. |
| Orçamento de tempo pode cortar emissão lenta legítima | Vira `NOT_READY` (409, "tente novamente"), não erro definitivo; o andamento fica salvo; ajustável por `SHIPPING_LABEL_BUDGET_MS`. |
| `get_shipping_document_parameter` adiciona 1 chamada | Best-effort: falha nela não interrompe nada; kill-switch. |
| Front atualizado × API antiga | `formatLabelError` mantém o fallback `message → error → padrão`. |
| CSP mais permissiva | Dois hosts explícitos de CDN da Shopee, sem curinga. |

---

## 10. Evidências de não-regressão

**Chamadas externas por emissão (Shopee)** — antes 7–14, depois 8–15. A única a mais é o
`get_shipping_document_parameter`, best-effort e desligável. Nenhuma chamada extra ao storage
(a leitura do XML é a mesma) e nenhuma consulta N+1 nova.

**Consumidores de cada função alterada** (`grep`, fora de teste):
`uploadInvoiceDoc` → 1 (`shopee-shipping.service.ts:114`); `downloadShippingDocument` → 1
(`shopee-shipping.service.ts:251`); `ShopeeApiService.buildSignedUrl` → 2, ambos sem query
(o split é defensivo). O `buildSignedUrl` **homônimo** de `shopee-oauth.service.ts` é outro método
e **não foi tocado**. `ShippingAuthRetry` → ML 5, Magalu 3, Shopee 3.

**ML e Magalu inalterados:** `ensureInvoiceSent` dos dois é implementação separada
(`ml-shipping.service.ts` usa `sendInvoiceData`; Magalu é no-op). O único código compartilhado que
mudou é o `ShippingAuthRetry`, e o retry nasce **desligado na suíte** — os 6 testes de
`auth-retry.spec.ts` e os 12 de `ml-shipping.service.spec.ts` passam sem alteração.

**Type-check:** `tsc --noEmit` = **100 erros antes e 100 depois**, nenhum em arquivo tocado.
(A baseline de 100 é pré-existente e não faz parte deste escopo.)

**Formatação:** o `prettier` do ambiente (3.9.6 global; não é dependência do projeto) reprova
também arquivos não tocados — rodar `--write` produziria churn não relacionado. Formatação deixada
como está, seguindo o estilo do entorno.

**Antes × depois no cenário do incidente:**

| | Antes | Depois |
|---|---|---|
| HTTP da rota | 500 | 502 (`PROVIDER_ERROR`) |
| Texto na tela | `Shopee upload_invoice_doc 404: Request failed with status code 404` | `Falha ao enviar a NF-e do pedido 2607290P63B8P8 na Shopee: …` |
| Código do parceiro | descartado | `error_not_found` / `error_param` |
| `request_id` | descartado | preservado |
| URL chamada | desconhecida | registrada, sem segredos |
| `SystemLog` | nenhum | log estruturado com `correlationId` |

**Sobre o pedido do incidente:** ele **não é recuperável por API**. A janela da Shopee fechou —
`get_shipping_parameter` responde *"Shipping parameters can only be obtained when package is ready
to be shipped"*, `create_shipping_document` falha e o download pede
`shipping_document_should_print_first`. O mesmo vale para os outros dois pedidos em `ERROR`
(`cms7donf202jr18ixn2d9fluw`, `cmrtxzflw01od18wjblp7qju6`). A correção previne a recorrência; esses
três precisam ser resolvidos pelo Seller Center.

---

## 10-B. Segunda rodada — validação local (04/08/2026, IP liberado na whitelist)

Com o IP da máquina de desenvolvimento cadastrado no Open Platform Console, o fluxo foi
exercitado ponta a ponta fora da VPS. **O A/B da causa raiz reproduziu idêntico de um segundo
ponto de rede** (`logistics` → 404 `error_not_found`; `order` → 200 com `request_id`), o que
descarta artefato de IP ou de região.

A rodada encontrou **quatro defeitos que os testes com HTTP mockado não pegavam** — todos
corrigidos e cobertos:

| # | Defeito | Por que escapou |
|---|---|---|
| 1 | Falha no **refresh de token** voltava como HTTP 500 com texto cru | Os `*OAuthService` lançam `Error` puro; o mock nunca exercitava o caminho do OAuth |
| 2 | `403 source_ip_undeclared` era tratado como **erro de auth** → refresh inútil e mensagem culpando a "autorização da conta" em vez do IP | Nenhum teste cobria 403 que não fosse de token |
| 3 | `get_shipping_parameter`, `get_address_list`, `ship_order`, `get_tracking_number`, `create_shipping_document` e `get_shipping_document_result` **ainda lançavam `Error` puro** → 500 opaco | Só `upload_invoice_doc` e `download_shipping_document` haviam sido tipados |
| 4 | `scripts/repro-shipping-label.ts` **não carregava o `.env`** | Na VPS as variáveis já estavam no ambiente |

Resultado no cenário do incidente, medido localmente:

```
ANTES  HTTP 500  {"message":"Erro ao obter parâmetros de envio Shopee: Shipping
                  parameters can only be obtained when package is ready to be shipped"}

DEPOIS HTTP 502  {"code":"PROVIDER_ERROR",
                  "message":"Falha ao consultar as opções de envio do pedido
                             2607290P63B8P8 na Shopee: Shipping parameters can only be
                             obtained when package is ready to be shipped
                             (referência Shopee: e3e3e7f3583f839f…)",
                  "correlationId":"req-1"}
```

## 10-C. Latência de ingestão — investigada e DESCARTADA como causa

Uma leitura preliminar sugeriu que os pedidos chegariam ao Dexo já despachados, tornando a
feature inútil. **A medição refutou isso.** Script: `scripts/diag-shopee-ingestion-latency.ts`
(somente leitura).

### O erro da leitura preliminar

Ela se apoiou em `Order.status`, que **não responde a pergunta**: `mapShopeeStatus`
(`order.usercase.ts:3603`) colapsa `READY_TO_SHIP`, `PROCESSED`, `SHIPPED`, `RETRY_SHIP`,
`TO_RETURN` e `TO_CONFIRM_RECEIVE` **todos em `SHIPPED` local**. Contar "359 SHIPPED" não distingue
"aguardando despacho" de "já despachado" — e `READY_TO_SHIP` é exatamente o estado em que a
etiqueta PODE ser gerada. Só o `order_status` da Shopee responde.

### Latência real (433 pedidos, 30 dias)

A distribuição global é **bimodal** e o p50 agregado (10,4 h) não descreve nenhum dos dois regimes.
Separando pela data da VENDA:

| Recorte | p50 | p90 | máx | < 15 min |
|---|---|---|---|---|
| **Vendidos a partir de 30/07** (regime atual) | **58 s** | 4 min | 29 min | **96,6%** (85/88) |
| Vendidos antes de 30/07 (backfill dos órfãos) | 10,0 d | 16,7 d | 28,3 d | 0% |

O segundo grupo são os pedidos órfãos recuperados em 29/07 — vendidos semanas antes, importados de
uma vez. Eram eles que contaminavam a média. **A ingestão em regime normal leva ~1 minuto: não é
gargalo.**

### Estado real na Shopee (429 pedidos consultados ao vivo)

| `order_status` | Qtd | Janela de etiqueta |
|---|---|---|
| COMPLETED | 270 | fechada |
| SHIPPED | 75 | fechada |
| TO_CONFIRM_RECEIVE | 42 | fechada |
| TO_RETURN | 24 | fechada |
| CANCELLED | 9 | — |
| **READY_TO_SHIP** | **7** | **ABERTA** |
| **PROCESSED** | **2** | **ABERTA** |

**Existem 9 pedidos com a janela aberta agora** — o mais antigo há **116,6 h** (≈5 dias). A janela
não é uma corrida contra o relógio: fica aberta por dias.

### Conclusão

A feature é viável, e a latência não a impede. **Nenhum dos 9 pedidos com janela aberta tem NF-e
55 autorizada** — o passo que falta é o fiscal, não o técnico. O pedido do incidente
provavelmente estava `READY_TO_SHIP` em 29/07 às 14:06, foi barrado pelo 404, e a janela fechou
nos dias seguintes.

### Achado colateral

Duas contas Shopee de `Jrmimports9@gmail.com` (shops `1796396261` e `1131967803`) estão com
**token vencido desde 28/07** e continuam marcadas `ACTIVE`. Falham silenciosamente há uma
semana — mesma classe de problema do incidente: erro real que não chega a ninguém.

## 11. Sugestões e dívida técnica

**Prioridade alta**
1. **Fechar o `file_type`** no próximo pedido Shopee ainda não despachado:
   `npx tsx scripts/repro-shipping-label.ts --order=<id> --apply` e, se der `error_param`,
   testar `--artifact=pdf`. É o último ponto não confirmado.
2. **Nenhum alerta existia.** Três pedidos ficaram em `ShipmentLabel.labelStatus = "ERROR"` por
   dias sem ninguém saber. Vale um alerta sobre `labelStatus = ERROR`.

**Prioridade média**

3. **React #418** (hydration mismatch, `4bd1b696-*.js`) — apareceu no console do incidente,
   **não tem relação** com a etiqueta e **não foi tocado** aqui, como combinado.
4. **`makeAuthenticatedRequest` ainda usa o catch antigo** (`Shopee API ${status}: ${message}`),
   com o mesmo defeito de ler só `message`. Não entrou nesta branch para não ampliar o raio —
   afeta importação, anúncios e sync. Migrar para `toIntegrationError` é o passo natural.
5. **`labelPdfPath` guarda caminho absoluto** no banco, acoplando o registro à máquina/volume.
6. **`FiscalStorageService` usa `readFileSync`/`writeFileSync`**, bloqueando o event loop.

**Prioridade baixa**

7. `"Baixar"` usa `window.open` sobre blob — sujeito a bloqueio de popup, e a mensagem de falha
   ("Nenhuma etiqueta gerada ainda") engana quando o problema é sessão ausente.
8. O fluxo de etiqueta monta `headers: { email }` na mão em vez de usar `authHeaders()` de
   `lib/api.ts` — quebra se a API passar a `API_AUTH_MODE=strict`.
9. `SHIPPING_STORAGE_PATH` não está definida na VPS; cai em `{cwd}/.shipping-storage`, que não
   sobrevive a um deploy que troque o diretório.
