# 🔄 Fluxo OAuth - Diagrama Visual

## FLUXO CORRETO (Esperado)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            FRONTEND (Next.js)                                │
│                      http://localhost:3000                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │ ml-connection-tab.tsx                                            │      │
│  │                                                                  │      │
│  │ User clica "Conectar"                                           │      │
│  │         │                                                       │      │
│  │         ▼                                                       │      │
│  │ handleConnect()                                                 │      │
│  │    │                                                            │      │
│  │    ├─ POST /marketplace/ml/auth                                 │      │
│  │    │    headers: { email: "user@example.com" }  ────────┐      │      │
│  │    │                                               ┌─────┼──────┼──────┤
│  │    │ (recebe)                                      │     │      │      │
│  │    │ {                                             │     │      │      │
│  │    │   authUrl: "https://auth.ml.com/auth?...",   │     │      │      │
│  │    │   state: "abc123..."                          │     │      │      │
│  │    │ }                                             │     │      │      │
│  │    │                                               │     │      │      │
│  │    ▼                                               │     │      │      │
│  │ window.open(authUrl, "ml-oauth")                   │     │      │      │
│  │    │                                               │     │      │      │
│  │    ├─ Popup abre com redirect ML              ┌────┼─────┼──────┼────┐│
│  │    │                                           │    │     │      │    ││
│  │    ▼                                           │    │     │      │    ││
│  │ Inicia polling (cada 500ms)                    │    │     │      │    ││
│  │    if (popup.closed) {                         │    │     │      │    ││
│  │      fetchStatus()  ◄─────────────────────┐    │    │     │      │    ││
│  │    }                                       │    │    │     │      │    ││
│  │                                            │    │    │     │      │    ││
│  │ Listener de postMessage                    │    │    │     │      │    ││
│  │    if (message.type === "ML_OAUTH_SUCCESS")     │    │     │      │    ││
│  │      fetchStatus()  ◄────────────────────┼─────┘    │     │      │    ││
│  │                                           │         │     │      │    ││
│  └──────────────────────────────────────────┼────────┼──────┼──────┘    ││
│                                              │         │      │           │
└──────────────────────────────────────────────┼─────────┼──────┼───────────┘
                        POPUP REDIRECT         │         │      │
                             ▼                 │         │      │
     ┌────────────────────────────────────────┼──────────┼──────┼────────┐
     │       MERCADO LIVRE Auth Server         │         │      │        │
     │       https://auth.mercadolibre.com     │         │      │        │
     │                                         │         │      │        │
     │  User Autoriza Aplicação                │         │      │        │
     │         │                               │         │      │        │
     │         ▼                               │         │      │        │
     │  ML redireciona para REDIRECT_URI       │         │      │        │
     │  Location: https://seu-backend/        │         │      │        │
     │    integracoes/mercado-livre/callback  │         │      │        │
     │    ?code=...&state=...                 │         │      │        │
     │         │                              │         │      │        │
     └─────────┼──────────────────────────────┼─────────┼──────┼────────┘
               │  Popup Navega                │         │      │
               ▼  (PROBLEMA: URL diferente!)   │         │      │
     
     ┌─────────────────────────────────────────────────────────────────┐
     │ POPUP: callback/page.tsx                                         │
     │ https://seu-backend/integracoes/mercado-livre/callback?...      │
     │                                                                   │
     │ useEffect(() => {                                                │
     │   code = url.searchParams.get("code")                            │
     │   state = url.searchParams.get("state")                          │
     │                                                                   │
     │   GET /marketplace/ml/callback?code=...&state=... ──────┐        │
     │     (SEM headers de auth - CORRETO!)                     │        │
     │                                                           │        │
     │   Backend:                                                │        │
     │    1. Valida state (CSRF check)                           │        │
     │    2. Troca code por tokens (ML API)                      │        │
     │    3. Obtem info do seller                                │        │
     │    4. Cria conta no banco (MarketplaceAccount)            │        │
     │    5. Retorna sucesso (200 OK)                            │        │
     │                                                           │        │
     │   window.opener.postMessage(                              │        │
     │    { type: "ML_OAUTH_SUCCESS" },                          │        │
     │    "https://seu-backend"  ◄─ ⚠️ PROBLEMA!                │        │
     │   )                                                       │        │
     │    ⚠️ Se opener está em localhost, origins não batem!    │        │
     │                                                           │        │
     │   window.close()                                          │        │
     │ })                                                        │        │
     │                                                           │        │
     │ PROBLEMA: postMessage pode falhar silenciosamente       │        │
     │           se origins não combinam                        │        │
     └─────────────────────┬───────────────────────────────────┼────────┘
                           │                                  │
                           ▼ (SE postMessage FUNCIONAR)       │ (SE NÃO FUNCIONAR)
           ┌──────────────────────────────────┐               │
           │ ml-connection-tab.tsx             │               │
           │ handleMessage() dispara           │               │
           │    fetchStatus()                  │               │
           │    popup.close()                  │               │ Timeout 550s
           │                                   │               │ Polling detecta
           └───────────────────────────────────┘               │ popup.closed
                           │                                   │
                           └───────────────┬───────────────────┘
                                          ▼
                    ┌──────────────────────────────────┐
                    │ fetchStatus()                     │
                    │  GET /marketplace/ml/status       │
                    │  GET /marketplace/ml/accounts     │
                    │                                   │
                    │ Status renderiza "Conectado ✅"   │
                    └──────────────────────────────────┘
```

---

## FLUXO COM PROBLEMAS (Real)

```
TIMELINE REAL (com problemas):

T+0ms      User em http://localhost:3000 clica "Conectar"
           │
T+50ms     ├─ POST /marketplace/ml/auth
           │  (headers: { email: "user..." })
           │
T+100ms    ├─ Recebe { authUrl: "...", state: "..." }
           │
T+120ms    ├─ window.open(authUrl) - POPUP ABRE
           │
T+130ms    ├─ Inicia polling (checkClosed = setInterval(..., 500))
           │  Inicia listener de postMessage
           │
T+1000ms   │ (no popup)
           │ User em auth.mercadolibre.com clica "Autorizar"
           │
T+1500ms   │ ML redireciona popup para:
           │ https://abc123.ngrok-free.app/integracoes/mercado-livre/callback?code=...
           │ (⚠️ NOTA: Backend foi parametrizado com ngrok URL como REDIRECT_URI)
           │
T+2000ms   │ callback/page.tsx carrega no popup
           │ Chama GET /marketplace/ml/callback?code=...&state=...
           │
T+2100ms   │ Backend processa:
           │  - Valida state ✅
           │  - Troca code por tokens ✅
           │  - Salva conta no banco ✅
           │  - Retorna 200 OK ✅
           │
T+2200ms   │ callback/page.tsx recebe sucesso
           │ Tenta notifyParent("ML_OAUTH_SUCCESS", undefined)
           │   window.opener.postMessage(
           │     { type: "ML_OAUTH_SUCCESS" },
           │     window.location.origin  // "https://abc123.ngrok-free.app"
           │   )
           │
T+2210ms   │ 🔴 PROBLEMA: postMessage FALHA SILENCIOSAMENTE!
           │    Motivo: opener.origin = "http://localhost:3000"
           │            callback.origin = "https://abc123.ngrok-free.app"
           │            Não combinam! ❌
           │
T+2300ms   │ callback/page.tsx chama window.close()
           │
T+2350ms   │ (no browser frontend)
           │ Listener NÃO recebe nada (postMessage falhou)
           │ Polling ainda aguardando (checkClosed ainda ativo)
           │
T+2850ms   │ Polling detecta popup.closed === true  (300-500ms depois)
           │ clearInterval(checkClosed)
           │ setIsConnecting(false)
           │ fetchStatus() CHAMADA  ◄────── Só agora!
           │
T+2900ms   │ GET /marketplace/ml/status
           │ GET /marketplace/ml/accounts
           │ (com 2 segundos de delay!)
           │
T+3050ms   │ Status atualiza: "Conectado ✅"
           │
           │ User: "Por que demorou 3 segundos? 😞"

---

COMPARAÇÃO:
Cenário ideal (postMessage funciona):    T+2200ms → fetchStatus → Status em T+2300ms ✅ (100ms)
Cenário real (postMessage falha):         T+2200ms → polling → Status em T+2850ms ❌ (650ms + delay)

PIOR CASO (sem internet rápida):
  Backend processa lentamente            T+2500ms
  Polling aguarda 500ms extra           T+3400ms
  Teias lentas de resposta              T+3800ms
  User aguarda 3-4 segundos              😞😞😞
```

---

## SEQUÊNCIA DE PROBLEMAS

### Problema 1: targetOrigin Mismatch

```
┌─────────────────────────┐
│ callback/page.tsx       │
├─────────────────────────┤
│ Origin: GET URL         │
│ https://abc123.ngrok... │
│                         │
│ window.opener.postMessage(
│   { type: "..." },
│   window.location.origin  ◄─ AQUI!
│ )                       │
│                         │
│ Problem: opener não está│
│ no mesmo origin!        │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ window.opener           │
├─────────────────────────┤
│ Origin:                 │
│ http://localhost:3000   │
│                         │
│ ❌ MISMATCH!            │
│ postMessage FALHA       │
│ silenciosamente!        │
└─────────────────────────┘

✅ CORRETO: window.opener.location.origin
   Pega origin do opener, não do callback!
```

### Problema 2: Condição de Corrida (Race Condition)

```
┌─────────────────────────────────────────────┐
│ Múltiplos paths chamam fetchStatus()        │
├─────────────────────────────────────────────┤
│                                             │
│ Path 1: useEffect ao montar                 │
│   Session carrega                           │
│   fetchStatus() chamada  ◄────── CHAMADA 1  │
│                                             │
│ Path 2: postMessage listener                │
│   Backend retorna sucesso                   │
│   window.opener.postMessage() dispara       │
│   handleMessage() executa                   │
│   fetchStatus() chamada  ◄────── CHAMADA 2  │
│                                             │
│ Path 3: polling                             │
│   popup.closed detectado                    │
│   fetchStatus() chamada  ◄────── CHAMADA 3  │
│                                             │
│ RESULTADO:                                  │
│ fetchStatus() chamada em:                   │
│   T+2100ms (Path 1 - mounting)              │
│   T+2200ms (Path 2 - postMessage)           │
│   T+2850ms (Path 3 - polling)               │
│                                             │
│ Sobreposição de estados React!              │
│ Comportamento não-determinístico            │
│ Possível inconsistência de dados            │
│                                             │
└─────────────────────────────────────────────┘

SOLUÇÃO: Usar apenas UM path (postMessage é mais rápido)
         Remover polling OU postMessage, não ambos!
```

### Problema 3: Sem Debouncing

```
┌─────────────────────────────────────────┐
│ fetchStatus() chamadas consecutivas      │
├─────────────────────────────────────────┤
│                                         │
│ T+2100ms  fetchStatus() ─┐              │
│           ├─ GET /status │              │
│           └─ GET /accs   │              │
│                          │              │
│ T+2200ms  fetchStatus() ─┤┐             │
│           ├─ GET /status ││             │
│           └─ GET /accs   ││             │
│                          ││             │
│ T+2850ms  fetchStatus() ─┤┤┐            │
│           ├─ GET /status │││            │
│           └─ GET /accs   │││            │
│                          │││            │
│ TOTAL: 6 requests em 750ms              │
│                                         │
│ Se backend lento (200ms resposta):      │
│ T+2100  → 2 requests                    │
│ T+2200  → 2 requests (anterior ainda!)  │
│ T+2300  → 2 requests (colisão!)         │
│ T+2400  → 2 requests (colisão!)         │
│ ...                                     │
│                                         │
│ Possível banco de dados timeout!        │
│                                         │
└─────────────────────────────────────────┘

SOLUÇÃO: Debouncing de 1000ms
         Máximo uma chamada a cada 1 segundo
         Agrupa múltiplas solicitações em uma
```

---

## MAPA DE TESTES

```
Teste 1: OAuth em DEV (sem ngrok)
┌────────────────────────────────────────────────┐
│ ✅ PROVAVELMENTE FUNCIONA                        │
├────────────────────────────────────────────────┤
│ - Frontend: http://localhost:3000              │
│ - Callback: http://localhost:3000/callback     │
│ - Origins COMBINAM ✅                           │
│ - postMessage funciona ✅                       │
│ - fetchStatus() chamada 2-3x mas rápido ⚠️     │
│ - User vê "Conectado" em ~1-2 segundos        │
│ - Resultado: SUCESSO (com warnings)            │
└────────────────────────────────────────────────┘

Teste 2: OAuth em PRODUÇÃO (ngrok)
┌────────────────────────────────────────────────┐
│ ❌ NÃO FUNCIONA                                  │
├────────────────────────────────────────────────┤
│ - Frontend: http://localhost:3000              │
│ - ML redireciona para: https://abc123.ngrok... │
│ - Callback URL: https://abc123.ngrok.../cb    │
│ - Origins NÃO COMBINAM ❌                       │
│ - postMessage falha silenciosamente            │
│ - Polling aguarda 500ms + ...                  │
│ - User vê loading por ~5 minutos               │
│ - Resultado: FALHA (timeout)                   │
└────────────────────────────────────────────────┘

Teste 3: AUTH HEADER (email)
┌────────────────────────────────────────────────┐
│ ✅ FUNCIONA CORRETAMENTE                        │
├────────────────────────────────────────────────┤
│ Frontend envia: { email: "user@..." }          │
│ Backend espera: request.headers["email"]       │
│ Middleware valida: findByEmail() ✅             │
│ request.user = { id, email, ... }  ✅          │
│ Resultado: SUCESSO                              │
└────────────────────────────────────────────────┘

Teste 4: CALLBACK PROCESSING
┌────────────────────────────────────────────────┐
│ ✅ FUNCIONA CORRETAMENTE                        │
├────────────────────────────────────────────────┤
│ GET /callback?code=...&state=...  ✅           │
│ Validação de state (CSRF)  ✅                  │
│ Troca code por tokens (ML API)  ✅             │
│ Cria/atualiza conta (Prisma)  ✅               │
│ Retorna sucesso (200)  ✅                      │
│ Tokens salvos no banco  ✅                     │
│ Resultado: SUCESSO                              │
└────────────────────────────────────────────────┘
```
