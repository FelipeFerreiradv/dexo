# Incidente 25/08/2026 — Shopee: o pipeline de etiqueta se auto-trancava

| | |
|---|---|
| **Data do incidente** | 24/08/2026, 14:10–14:17 UTC (11:10–11:17 America/Sao_Paulo) |
| **Cliente** | `comerciodlsautopeca@gmail.com` — conta "SHOPEE dls peça", shop `1322438439` |
| **Pedido** | `2608221M2DR72U` — id interno `cmt3m3rx60vmn1868oqzo0sam`, R$ 308,62, `PAID` |
| **Sintoma** | `POST /orders/:id/shipping-label` → HTTP 502; UI exibia `Falha ao consultar as opções de envio do pedido 2608221M2DR72U na Shopee: Package OFG241055916134686 not eligible for rescheduling` |
| **Impacto** | **14 pedidos** presos em `ShipmentLabel.labelStatus = "ERROR"`, permanentemente. Nenhuma etiqueta da Shopee jamais foi gerada em produção. |
| **Investigado em** | 25/08/2026, contra a API de produção da Shopee e o banco de produção |
| **Branch** | `claude/shopee-label-rescheduling-error-09dbb0` |

---

## 1. Causa raiz

**O pipeline cria o estado que o bloqueia.**

`get_shipping_parameter` existe, na Shopee, para **arranjar ou remarcar** o envio de um pedido.
Um pacote cujo envio já foi arranjado não pode mais ser remarcado — e a Shopee recusa a consulta.

Quem arranja o envio é o **nosso próprio `ship_order`**, na tentativa anterior. E
`get_shipping_parameter` é a **primeira** etapa da cadeia de `ensureReadyToShip`. Resultado: a
primeira emissão avança até o fim e falha por outro motivo; da segunda em diante o pipeline morre
na largada, para sempre.

Sequência completa, reconstruída do log de produção:

```
1a tentativa
   get_shipping_parameter   OK
   ship_order               OK   <- ARRANJA O ENVIO (é aqui que o estado muda)
   get_tracking_number      ->   ""  (a Shopee ainda não gerou o código)
   grava READY_TO_PRINT
   create_shipping_document FALHA  common.batch_api_all_failed
                                   result_list[0].fail_error = logistics.package_can_not_print
                                   "The document is not yet ready for printing.
                                    Please try again later."
   -> PROVIDER_ERROR (502), grava labelStatus = ERROR

2a tentativa em diante
   upload_invoice_doc       FALHA  "Upload is not accepted after shipment is arranged"
                            ->     TOLERADO (isInvoiceNoLongerAccepted), segue
   get_shipping_parameter   FALHA  error_other — "Package OFG… not eligible for rescheduling"
   -> PROVIDER_ERROR (502), grava labelStatus = ERROR
```

**A prova estava três linhas acima, no mesmo log.** A tolerância que já existia em
`ensureInvoiceSent` reconhece "envio já arranjado" e segue em frente — e a etapa seguinte morre
pelo mesmo fato que a anterior acabou de tolerar:

```
23200  [Shipping] Shopee não aceita mais a NF-e do pedido 2608221M2DR72U (envio já arranjado)
23203  falha de integração  step=get_shipping_parameter  "not eligible for rescheduling"
23204  [Shipping] Falha ao gerar etiqueta do pedido cmt3m3rx60vmn1868oqzo0sam: …
```

### Corpo cru da Shopee

```json
{"marketplace":"SHOPEE","operation":"shopee.logistics.get_shipping_parameter",
 "step":"get_shipping_parameter","httpStatus":200,
 "providerErrorCode":"error_other",
 "providerMessage":"Package OFG241055916134686 not eligible for rescheduling",
 "providerRequestId":"e3e3e7f359cba1e19f4c48af84a76400:0400009a68a74adb:03000081a4bcc52b",
 "orderId":"cmt3m3rx60vmn1868oqzo0sam","orderSn":"2608221M2DR72U",
 "shopId":1322438439,"outcome":"error"}
```

`httpStatus: 200` — é erro de negócio, não de transporte. `integrationErrorFromBody` fixa 200, o
que torna `isTransient` e `isDeterministic4xx` ambos falsos: **nenhum retry alcança este caso**.
Clicar de novo refaz tudo e falha idêntico.

### Defeito nº 2 — o motivo real enterrado no `result_list`

O `create_shipping_document` responde com um erro de topo que não diz nada:

```json
{"error":"common.batch_api_all_failed",
 "message":"All failed, please check result_list for detail",
 "response":{"result_list":[{"order_sn":"2608221M2DR72U",
   "fail_error":"logistics.package_can_not_print",
   "fail_message":"The package can not print now.  Detail: The document is not yet ready
                   for printing. Please try again later."}]}}
```

Era a mensagem de topo — *"All failed, please check result_list for detail"* — que chegava ao
lojista. O motivo real, que é **temporário** e no qual a própria Shopee manda tentar de novo,
ficava dentro do `result_list` e virava `PROVIDER_ERROR` permanente. **9 dos 17 pedidos presos
caíram aqui.**

Os dois defeitos se combinam num impasse perfeito: o defeito nº 2 exige uma retentativa, e o
defeito nº 1 impede que a retentativa chegue a algum lugar.

### O código de erro NÃO serve de critério

A Shopee usa **dois códigos diferentes para a mesma condição**:

| Código | Mensagem | Estado do pacote |
|---|---|---|
| `error_other` | `Package OFG… not eligible for rescheduling` | envio criado, não coletado (`LOGISTICS_REQUEST_CREATED`) |
| `error_param` | `Shipping parameters can only be obtained when package is ready to be shipped` | já coletado ou entregue |

`error_other` e `error_param` são os baldes genéricos da Shopee. Casar por código toleraria
**qualquer** erro desta etapa — exatamente o catch genérico que não se quer. **O critério é o
texto**, com as duas frases escritas por extenso.

A segunda alternativa é escrita por inteiro por outro motivo: `/ready/` sozinho casaria também
com *"not ready"*, que significa o oposto.

### `trackingNumber` é string VAZIA, não `null`

Nos 14 registros presos, `ShipmentLabel.trackingNumber = ''` — nunca `null`. A Shopee devolve
`tracking_number: ""` na janela logo após o `ship_order`, e é esse valor que ficou gravado.

Qualquer verificação de "há rastreio?" escrita como `!= null` deixaria `""` passar como rastreio
válido. O teste tem que ser **`.trim()` não-vazio**.

---

## 2. Estado real na Shopee (leitura ao vivo, 25/08/2026)

Do pedido do incidente:

```
order_status           : PROCESSED
package_number         : OFG241055916134686        (bate com a mensagem de erro)
logistics_status       : LOGISTICS_REQUEST_CREATED
shipping_carrier       : Shopee Xpress
tracking_number        : BR267967530076P           <- EXISTE
doc selectable         : ["NORMAL_AIR_WAYBILL","THERMAL_AIR_WAYBILL"]
doc suggested          : NORMAL_AIR_WAYBILL
get_shipping_parameter : error_other — not eligible for rescheduling
```

**A etiqueta está disponível, inclusive a Térmica 10×15 que a vendedora pediu.** O único
obstáculo era o nosso pipeline.

Varredura dos 14 pedidos presos, todos da mesma conta:

| Pedido | order_status | logistics_status | rastreio | doc selectable | get_shipping_parameter |
|---|---|---|---|---|---|
| 2608221M2DR72U | PROCESSED | LOGISTICS_REQUEST_CREATED | BR267967530076P | NORMAL, THERMAL | `error_other` rescheduling |
| 26082596BPV7GE | SHIPPED | LOGISTICS_PICKUP_DONE | BR265889750996B | NORMAL, THERMAL | `error_param` |
| 2608258BPTKE52 | SHIPPED | LOGISTICS_PICKUP_DONE | BR260917436613S | NORMAL, THERMAL | `error_param` |
| 2608221EV66R3J | SHIPPED | LOGISTICS_PICKUP_DONE | BR268267031717X | NORMAL, THERMAL | `error_param` |
| 2608210KP1T5GP | SHIPPED | LOGISTICS_PICKUP_DONE | BR2687967676713 | NORMAL, THERMAL | `error_param` |
| 260820TDR1UMR0 | TO_CONFIRM_RECEIVE | LOGISTICS_DELIVERY_DONE | BR2658806253517 | NORMAL, THERMAL | `error_param` |
| 260820RUWXSSNH | COMPLETED | LOGISTICS_DELIVERY_DONE | BR2630182581936… | NORMAL, THERMAL | `error_param` |
| 260817KPF584BH | TO_CONFIRM_RECEIVE | LOGISTICS_DELIVERY_DONE | BR260153060473Y | NORMAL, THERMAL | `error_param` |
| 260816FWEVC9YV | COMPLETED | LOGISTICS_DELIVERY_DONE | BR269171715100C | NORMAL, THERMAL | `error_param` |
| 2608114KC29W63 | TO_RETURN | LOGISTICS_DELIVERY_DONE | BR268919443457C | NORMAL, THERMAL | `error_param` |
| 2608112GY5A6C9 | TO_RETURN | LOGISTICS_DELIVERY_DONE | BR268689823350D | NORMAL, THERMAL | `error_param` |
| 26081013AU99X4 | COMPLETED | LOGISTICS_DELIVERY_DONE | BR264354308312S | NORMAL, THERMAL | `error_param` |
| 2608100Q9EDR1T | COMPLETED | LOGISTICS_DELIVERY_DONE | BR262616270503T | NORMAL, THERMAL | `error_param` |
| 260806JXC7HQBR | COMPLETED | LOGISTICS_DELIVERY_DONE | BR269096273570T | NORMAL, THERMAL | `error_param` |
| 2607290P63B8P8 | COMPLETED | LOGISTICS_DELIVERY_DONE | BR266234950831I | NORMAL, THERMAL | `error_param` |

**Todos têm rastreio real e etiqueta disponível.** Os 14 falhavam em `get_shipping_parameter` na
retentativa, independentemente de onde tinham falhado da primeira vez.

### Estado no banco

```
ShipmentLabel   : GENERATED 29  |  ERROR 18
ERROR por etapa : create_shipping_document 9 · get_shipping_parameter 6 · outros 3
ERROR por conta : SHOPEE dls peça 17  ·  777AUTOPARTS 1 (Mercado Livre, outro assunto)
```

**Os 29 `GENERATED` são todos do Mercado Livre.** Nenhuma etiqueta da Shopee jamais foi gerada
em produção — o "caminho feliz da Shopee" existia como código e teste, não como fato observado.

Não é característica desta cliente: há 23 contas Shopee ativas, e qualquer uma cujo `ship_order`
tenha sucesso cai no mesmo poço. Ela foi a única a chegar lá porque é a única com volume de
emissão pela Shopee.

---

## 3. Correção ao registro do incidente de 29/07/2026

A seção 10 de [`2026-07-29-shopee-upload-invoice-doc-404.md`](2026-07-29-shopee-upload-invoice-doc-404.md)
afirma que o pedido `2607290P63B8P8` **"não é recuperável por API"**, citando como evidência
justamente a mensagem *"Shipping parameters can only be obtained when package is ready to be
shipped"*.

**Essa conclusão estava errada.** Aquela mensagem não era a janela da Shopee fechando: era este
bug, um mês antes de ser diagnosticado. O pedido tem rastreio (`BR266234950831I`) e etiqueta
disponível (`NORMAL_AIR_WAYBILL`, `THERMAL_AIR_WAYBILL`), e está entre os 14 destravados por esta
correção. O mesmo vale para os outros dois citados lá.

A lição: **uma recusa do parceiro foi lida como estado terminal do pedido sem confirmar o estado
real com `get_order_detail`/`get_tracking_number`.** A mensagem de erro descreve o que a chamada
não pôde fazer, não o que o pedido é.

---

## 4. Fluxo antigo

```
UI "Emitir etiqueta"
  |- POST /orders/:id/shipping-label
       |- generateLabelForOrder -- lock -- idempotência (só reusa GENERATED)
            |- produceRawLabel
                 |- ensureInvoiceSent
                 |    |- "not accepted after shipment is arranged" -> TOLERADO, segue  OK
                 |- ensureReadyToShip
                 |    |- get_shipping_parameter                                     FALHA
                 |         200 + error_other "not eligible for rescheduling"
                 |         SEM try/catch — única etapa do arquivo sem tolerância
                 |         -> propaga
                 |- getLabelPdf                                   <- nunca alcançado
            catch: MarketplaceIntegrationError
                   -> PROVIDER_ERROR (502) + grava labelStatus = ERROR
  próximo clique: ERROR não é reaproveitado -> refaz tudo -> falha idêntico, para sempre
```

## 5. Fluxo novo

```
UI "Emitir etiqueta"
  |- POST /orders/:id/shipping-label
       |- generateLabelForOrder -- lock -- idempotência
            |- produceRawLabel
                 |- ensureInvoiceSent                              (inalterado)
                 |- ensureReadyToShip
                 |    |- get_shipping_parameter
                 |         |- OK    -> buildShipBody -> ship_order -> tracking
                 |         |          (CAMINHO FELIZ, byte a byte igual)
                 |         |- FALHA -> [NOVO] isShippingParameterNoLongerApplicable?
                 |              |- não -> propaga (comportamento de hoje)
                 |              |- sim -> log explícito + PULA ship_order
                 |                       |- get_tracking_number
                 |                            |- trim() não-vazio -> ready: true
                 |                            |- vazio ou erro    -> ready: false
                 |                                                   -> NOT_READY (409)
                 |                                                   -> NÃO marca ERROR
                 |- getLabelPdf
                      |- get_shipping_document_parameter           (inalterado)
                      |- create_shipping_document
                      |    |- FALHA -> [NOVO] isLabelNotReadyYet?
                      |         |- não -> propaga (comportamento de hoje)
                      |         |- sim -> NOT_READY (409)
                      |                   "Tente novamente em alguns instantes"
                      |                   -> NÃO marca ERROR (estado fica READY_TO_PRINT)
                      |- poll -> download                          (inalterado)
```

---

## 6. Arquivos alterados

| Arquivo | Por quê |
|---|---|
| `app/marketplaces/services/shopee-shipping.service.ts` | **Causa raiz.** `isShippingParameterNoLongerApplicable` + `try/catch` em volta do `getShippingParameter`; `isLabelNotReadyYet` + `try/catch` em volta do `createShippingDocument`. Os dois predicados ficam ao lado de `isAlreadyArranged` e `isInvoiceNoLongerAccepted`, com o comentário contando o incidente. |
| `app/marketplaces/services/shopee-api.service.ts` | `createShippingDocument` anexa `shopeeFailError`/`shopeeFailMessage` ao erro tipado, extraídos do `result_list`. Mesmo padrão que o `shipOrder` já usa com `shopeeError`/`shopeeMessage`. Aditivo: nenhum leitor existia. |
| `.env.example` | Dois kill-switches novos, no bloco "Kill-switches da resiliencia", cada um contando o incidente. |
| `vitest.config.ts` | `??= "1"` para os dois — é isso que mantém os specs anteriores byte-idênticos. |
| `app/marketplaces/services/__tests__/shopee-shipping.service.spec.ts` | 13 testes novos (8 do defeito nº 1, 5 do nº 2). |
| `app/marketplaces/shipping/__tests__/shipping-label-resilience.spec.ts` | 3 testes ponta a ponta. |

**Kill-switches novos** (default = ligado em produção; `=1` volta ao comportamento anterior):

| Env | Efeito quando desligada |
|---|---|
| `SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED` | a recusa do `get_shipping_parameter` volta a propagar como `PROVIDER_ERROR` |
| `SHOPEE_LABEL_NOT_READY_TOLERANT_DISABLED` | `logistics.package_can_not_print` volta a ser `PROVIDER_ERROR` em vez de `NOT_READY` |

**Não foram tocados:** `isAlreadyArranged`, `isInvoiceNoLongerAccepted`, lock por pedido,
orçamento de tempo, pré-checagem do XML, retry de transitório, `shipping-label.usecase.ts`,
`integration-error.ts`, providers de ML e Magalu, rota, front-end, NF-e, lote, download de
etiqueta já gerada.

---

## 7. Justificativa técnica

- **Casar por texto, não por código.** Contraintuitivo, e contrário à regra geral de preferir
  identificadores estáveis — mas aqui os identificadores (`error_other`, `error_param`) são
  genéricos demais para discriminar qualquer coisa. As duas frases, ao contrário, são específicas.
  No defeito nº 2 a relação se inverte: `logistics.package_can_not_print` é específico e **é** o
  critério, com a regex sobre a `fail_message` só como reforço.
- **Confirmação positiva antes de declarar pronto.** Não basta reconhecer a recusa; é preciso
  provar que o envio existe. O rastreio é esse fato, independente da mensagem de erro. Sem ele,
  a frase *"…when package is ready to be shipped"* também caberia num pedido que **ainda não**
  chegou lá, e pular o `ship_order` seria errado.
- **`NOT_READY` em vez de `PROVIDER_ERROR`.** `NOT_READY` devolve 409, mantém o estado e **não**
  marca o pedido. Foi marcar `ERROR` numa condição que significa "você já passou desta etapa" que
  produziu os 14 presos. O precedente já existia no mesmo método: `getLabelPdf` lança `NOT_READY`
  quando o poll esgota.
- **Tolerar uma condição nomeada, não uma etapa.** Cada `catch` novo verifica um predicado
  específico e relança tudo que não casa, com log explícito quando tolera.

---

## 8. Testes

**Defeito nº 1** — `shopee-shipping.service.spec.ts`, describe
*"get_shipping_parameter recusado após o envio arranjado"* (8):

| Teste | Afirma |
|---|---|
| pronto com "not eligible for rescheduling" e rastreio | `ready: true`, rastreio devolvido, **`shipOrder` NÃO chamado** |
| pronto na outra frase, "ready to be shipped" | idem, segunda alternativa da regex |
| não pronto sem rastreio | `ready: false`, `reason` com a mensagem da Shopee |
| rastreio vazio conta como ausência | `"   "` → `ready: false` |
| falha do `get_tracking_number` não vira sucesso | `ready: false` |
| falha genuína continua propagando | "Order does not exist" → lança |
| "not ready" NÃO é tolerado | significa o oposto — lança |
| kill-switch `=1` | lança e nem chega a buscar rastreio |

**Defeito nº 2** — describe *"documento de envio ainda não está pronto"* (4) + 1 no describe de
baixo nível, que prova que o `fail_error` do `result_list` chega ao adapter.

**Ponta a ponta** — `shipping-label-resilience.spec.ts` (3): o pedido sai de `ERROR` e chega a
`GENERATED` sem chamar `ship_order`; sem rastreio para em `NOT_READY` sem marcar `ERROR`;
kill-switch volta a `PROVIDER_ERROR`.

**Não-regressão do caminho feliz:** os 4 testes anteriores de `ensureReadyToShip` (DROPOFF,
PICKUP, NF-e validando, "already arranged") e os 4 de `getLabelPdf` seguem verdes sem alteração —
afirmam que `shipOrder` **é** chamado, com `body.dropoff`/`body.pickup` corretos.

---

## 9. Riscos analisados

| Risco | Mitigação |
|---|---|
| Pedido **não** arranjado pular o `ship_order` | Duas frases específicas **e** rastreio não-vazio. Sem rastreio nada é declarado pronto. |
| `buildShipBody` deixar de rodar | Só no ramo tolerado, onde não há `param` para montar corpo nenhum. Testes afirmam os dois lados. |
| Tolerância virar catch genérico | Regexes literais com mensagem real medida; o que não casa propaga, com teste dedicado. |
| Casar por texto quebrar se a Shopee reescrever a frase | O pedido volta a cair em `PROVIDER_ERROR` — falha **visível**, não silenciosa. Mesmo grau de acoplamento de `isInvoiceNoLongerAccepted`, que vive assim desde 29/07. |
| `NOT_READY` esconder falha real do `create_shipping_document` | Só quando `fail_error` é `logistics.package_can_not_print`. Qualquer outro motivo continua `PROVIDER_ERROR` (502). |
| Quebrar os testes anteriores | Ambos os kill-switches nascem desligados na suíte (`??= "1"`); os testes novos religam por caso. |
| ML e Magalu | Nenhum arquivo deles é tocado. |

---

## 10. Evidências de não-regressão

**Raio de explosão.** `ShopeeApiService.getShippingParameter` tem **um único** call-site de
produção (`shopee-shipping.service.ts:140`); o outro é `scripts/repro-shipping-label.ts`.
`ensureReadyToShip` da Shopee só é invocado de `shipping-label.usecase.ts:214`.

**Chamadas externas por emissão:** inalteradas no caminho feliz. No ramo tolerado há **uma a
menos** (o `ship_order` é pulado).

**Suíte:** `app/marketplaces` + catálogo = **482 testes verdes em 52 arquivos** (28 novos nesta
branch, somando os do Hyundai HR). `shipping` + providers isolados: 171 verdes.

**Type-check:** `tsc --noEmit` = **98 erros antes e 98 depois**, nenhum em arquivo tocado. A
baseline de 98 é pré-existente.

**Formatação:** o repositório **já não passava** no `prettier --check` antes destas mudanças —
inclusive `vehicle-catalog.ts` e os specs anteriores. Rodar `--write` produziria churn não
relacionado. Os blocos novos foram conferidos individualmente contra a saída do prettier e batem;
a única diferença é o CRLF, que é a convenção do repositório.

**Antes × depois no cenário do incidente:**

| | Antes | Depois |
|---|---|---|
| HTTP da rota | 502 (`PROVIDER_ERROR`) | 200 com o PDF, ou 409 (`NOT_READY`) se ainda faltar rastreio |
| `labelStatus` | `ERROR`, permanente | `GENERATED` — ou `INVOICE_SENT`/`READY_TO_PRINT` enquanto aguarda |
| Texto na tela | `Falha ao consultar as opções de envio … not eligible for rescheduling` | a etiqueta, ou "Tente novamente em alguns instantes" |
| `ship_order` | chamado, sem ter o que arranjar | pulado |
| Recuperável | não, nunca | sim, sozinho |

**Pedidos destravados: 14.** Nenhum precisa de ação manual — a idempotência só reaproveita
`GENERATED`, então um registro em `ERROR` é reprocessado do zero a cada clique da vendedora.

**Não verificado nesta branch:** o `create_shipping_document` de verdade não foi disparado (é
escrita, e a autorização era só de leitura). O que está provado é que
`get_shipping_document_parameter` devolve `THERMAL_AIR_WAYBILL` para os 14 — ou seja, o documento
existe. Fechar a evidência exige emitir a etiqueta do `2608221M2DR72U` após o deploy.

---

## 11. Sugestões e dívida técnica

**Prioridade alta**

1. **Ainda não há alerta sobre `labelStatus = ERROR`.** A sugestão nº 2 do incidente de 29/07
   continua aberta, e é exatamente por isso que 14 pedidos ficaram presos por três semanas sem
   ninguém saber. Um alerta teria transformado este incidente numa tarefa de um dia.
2. **Emitir a etiqueta do `2608221M2DR72U`** logo após o deploy, para fechar a evidência.

**Prioridade média**

3. **`createShippingDocument` lança `Error` puro** (sem `.status`) no ramo em que o `result_list`
   traz falha mas `response.error` está vazio. Esse erro escapa da normalização do usecase e vira
   **500**, não 502. Não entrou aqui para não ampliar o raio.
4. **`STEP_LABEL` não cobre `get_tracking_number` nem `shipping_label`** — os dois vazam o
   identificador em inglês para a tela, via o `?? error.step` de `toUserFacingMessage`.
5. **A janela entre `ship_order` e o rastreio não é medida.** Sabemos que existe (o `""` gravado
   nos 14 registros prova), mas não quanto dura. Saber diria se vale um poll curto no
   `ensureReadyToShip` em vez de devolver `NOT_READY`.

**Prioridade baixa**

6. **`@@index([orderId])` é redundante** com `@unique` no mesmo campo em `ShipmentLabel`.
7. **Os `scripts/*.js` de bruteforce de assinatura** (`shopee-sign-*.js`, `hmac-test*.js`,
   `compare-sign.js` e afins) são resíduo do onboarding do OAuth. **O conteúdo não foi
   inspecionado nesta investigação**, mas reimplementam o HMAC à mão em vez de reusar
   `generateSignature` e merecem revisão quanto a credencial versionada.
