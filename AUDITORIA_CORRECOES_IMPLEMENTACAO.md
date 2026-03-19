# 🔧 CORREÇÕES NECESSÁRIAS - Implementação

## Priority 1: CRÍTICO (Implementar HOJE)

---

### Correção 1.1: Corrigir targetOrigin no postMessage

**Arquivo:** [app/integracoes/mercado-livre/callback/page.tsx](app/integracoes/mercado-livre/callback/page.tsx#L74)

**Problema:**

```typescript
// ❌ ERRADO: Usa origin do callback, não do opener
window.opener.postMessage({ type, message }, window.location.origin);
```

Se callback está em `https://abc123.ngrok-free.app` e opener em `http://localhost:3000`, postMessage falha.

**Solução:**

```typescript
// ✅ CORRETO: Usar origin do opener
const openerOrigin = new URL(window.opener.location.href).origin;
window.opener.postMessage({ type, message }, openerOrigin);

// Ou aceitar qualquer origin (menos seguro, mas funciona):
window.opener.postMessage({ type, message }, "*");
```

**Implementação Completa:**

Substituir função `notifyParent`:

```typescript
// Notifica janela pai (opener) sobre resultado
const notifyParent = (type: string, message?: string) => {
  try {
    if (
      typeof window !== "undefined" &&
      window.opener &&
      !window.opener.closed
    ) {
      // ✅ NOVO: Usar origin do opener ao invés de location.origin
      const openerOrigin = new URL(window.opener.location.href).origin;

      window.opener.postMessage(
        { type, message, timestamp: Date.now() },
        openerOrigin, // ✅ Será "http://localhost:3000" quando opener está lá
      );

      console.log(`[Callback] ✅ postMessage enviado para ${openerOrigin}`);
    } else {
      console.warn("[Callback] ⚠️ Popup opener não disponível ou fechado");
    }
  } catch (error) {
    console.error("[Callback] ❌ Erro ao enviar postMessage:", error);
  }
};
```

---

### Correção 1.2: Remover Polling Desnecessário

**Arquivo:** [app/integracoes/mercado-livre/components/ml-connection-tab.tsx](app/integracoes/mercado-livre/components/ml-connection-tab.tsx#L155-L185)

**Problema:**

```typescript
// ❌ ERRADO: Polling que causa race condition
const checkClosed = setInterval(() => {
  if (popup.closed) {
    clearInterval(checkClosed);
    setIsConnecting(false);
    fetchStatus(); // 🔴 Chamada duplicada
  }
}, 500);
```

Combinado com postMessage listener, causa fetchStatus() ser chamada 2x.

**Solução:**
postMessage é mais rápido (50-100ms) que polling (500ms). Remover polling, manter apenas postMessage.

**Implementação Completa:**

Substituir `handleConnect`:

```typescript
const handleConnect = async () => {
  const userEmail = session?.user?.email;

  if (!userEmail) {
    setError("Sessão não encontrada. Faça login novamente.");
    return;
  }

  setIsConnecting(true);
  setError(null);

  try {
    // 1. Obter URL de autenticação do backend
    const response = await fetch(`${getApiBaseUrl()}/marketplace/ml/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        email: userEmail,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.message || "Erro ao iniciar autenticação");
    }

    const { authUrl, state } = await response.json();

    // 2. Abrir popup com a URL de autorização
    const popup = window.open(
      authUrl,
      "ml-oauth",
      "width=600,height=700,scrollbars=yes,resizable=yes",
    );

    if (!popup) {
      throw new Error(
        "Não foi possível abrir o popup. Verifique se popups estão bloqueados.",
      );
    }

    // ✅ NOVO: RemoveR polling, deixar apenas listener de postMessage
    // ❌ REMOVIDO: const checkClosed = setInterval(...)
    // ❌ REMOVIDO: setTimeout de timeout

    // Fallback timeout (apenas para segurança, se postMessage falhar)
    const timeoutId = setTimeout(
      () => {
        if (!popup.closed) {
          popup.close();
        }
        setIsConnecting(false);
      },
      5 * 60 * 1000,
    ); // 5 minutos

    // Aguardar postMessage listener notificar sucesso
    // O listener é definido no useEffect abaixo e irá:
    // 1. clearTimeout(timeoutId)
    // 2. setIsConnecting(false)
    // 3. fetchStatus()
  } catch (err) {
    setIsConnecting(false);
    setError(err instanceof Error ? err.message : "Erro ao conectar");
  }
};
```

---

### Correção 1.3: Adicionar Debouncing em fetchStatus()

**Arquivo:** [app/integracoes/mercado-livre/components/ml-connection-tab.tsx](app/integracoes/mercado-livre/components/ml-connection-tab.tsx#L48-L80)

**Problema:**

```typescript
// ❌ ERRADO: Sem debouncing, chamado 2-3x em rápida sucessão
const fetchStatus = useCallback(async () => {
  const response = await fetch(`${getApiBaseUrl()}/marketplace/ml/status`, ...);
  // ...
}, [session?.user?.email]);
```

3 requests em paralelo causam race condition.

**Solução:**
Usar debouncing (máximo 1 chamada a cada 1000ms) com `useDebouncedCallback`.

**Implementação Completa:**

Opção 1 (com biblioteca useDebounce):

```typescript
import { useDebouncedCallback } from "use-debounce";

// Dentro do componente:
const fetchStatus = useDebouncedCallback(
  async () => {
    if (!session?.user?.email) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${getApiBaseUrl()}/marketplace/ml/status`, {
        headers: {
          email: session.user.email,
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Erro ao verificar status");
      }

      const data: ConnectionStatus = await response.json();
      setStatus(data);

      const accRes = await fetch(`${getApiBaseUrl()}/marketplace/ml/accounts`, {
        headers: { email: session.user.email },
      });

      if (accRes.ok) {
        const accData = await accRes.json();
        setAccounts(Array.isArray(accData.accounts) ? accData.accounts : []);
      } else {
        setAccounts([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setIsLoading(false);
    }
  },
  1000, // 1000ms debounce
);
```

Opção 2 (sem biblioteca, usando useRef):

```typescript
const lastFetchRef = useRef<number>(0);
const debounceDelayMs = 1000;

const fetchStatus = useCallback(async () => {
  const now = Date.now();
  const timeSinceLastFetch = now - lastFetchRef.current;

  // ✅ Evita chamadas muito próximas
  if (timeSinceLastFetch < debounceDelayMs) {
    console.log(
      `[fetchStatus] Debounced (${debounceDelayMs - timeSinceLastFetch}ms mais)`,
    );
    return;
  }

  lastFetchRef.current = now;

  if (!session?.user?.email) return;
  setIsLoading(true);
  setError(null);

  try {
    // ... resto do código igual
  } finally {
    setIsLoading(false);
  }
}, [session?.user?.email]);
```

**Instalação (se usar opção 1):**

```bash
npm install use-debounce
```

---

## Priority 2: ALTO (Implementar Próxima Semana)

---

### Correção 2.1: Adicionar Try/Catch no postMessage

**Arquivo:** [app/integracoes/mercado-livre/callback/page.tsx](app/integracoes/mercado-livre/callback/page.tsx)

**Melhoramento:**

```typescript
const notifyParent = (type: string, message?: string) => {
  try {
    if (
      typeof window !== "undefined" &&
      window.opener &&
      !window.opener.closed
    ) {
      const openerOrigin = new URL(window.opener.location.href).origin;

      // ✅ Adicionar logging
      console.log(
        `[Callback] Enviando ${type} para ${openerOrigin} (callback origin: ${window.location.origin})`,
      );

      window.opener.postMessage(
        { type, message, timestamp: Date.now() },
        openerOrigin,
      );
    } else {
      console.warn("[Callback] Opener não está disponível");
    }
  } catch (error) {
    console.error("[Callback] Erro ao enviar postMessage:", error);
    // Pode fazer fallback: recarregar página pai?
    // window.opener?.location.reload();
  }
};
```

---

### Correção 2.2: Adicionar Logging para Debug

**Arquivo:** [app/integracoes/mercado-livre/components/ml-connection-tab.tsx](app/integracoes/mercado-livre/components/ml-connection-tab.tsx)

**Adicionar:**

```typescript
const handleConnect = async () => {
  // ... código existente

  console.log(
    `[MLConnectionTab] Iniciando OAuth\n` +
      `  Frontend Origin: ${window.location.origin}\n` +
      `  Popup será redirecionado para ML\n` +
      `  ML redirecionará para: ${process.env.NEXT_PUBLIC_API_URL}/marketplace/ml/callback`,
  );

  const popup = window.open(authUrl, "ml-oauth", "...");

  // ... resto do código
};

// Adicionar listener de logging:
useEffect(() => {
  const handleMessage = (event: MessageEvent) => {
    console.log(
      `[MLConnectionTab] postMessage recebido\n` +
        `  Origin: ${event.origin}\n` +
        `  Current Origin: ${window.location.origin}\n` +
        `  Type: ${event.data?.type}\n` +
        `  Message: ${event.data?.message}`,
    );

    // ... resto do código
  };

  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}, [fetchStatus]);
```

---

### Correção 2.3: Melhorar Listener de postMessage

**Arquivo:** [app/integracoes/mercado-livre/components/ml-connection-tab.tsx](app/integracoes/mercado-livre/components/ml-connection-tab.tsx#L211-L230)

**Melhoramento:**

```typescript
useEffect(() => {
  const handleMessage = (event: MessageEvent) => {
    // ✅ Validar origem com mais detalhes
    const isLocalhost =
      event.origin.includes("localhost") || event.origin.includes("127.0.0.1");
    const isSameOrigin = event.origin === window.location.origin;

    if (!isLocalhost && !isSameOrigin) {
      console.warn(
        `[MLConnectionTab] postMessage rejeitado de origem desconhecida: ${event.origin}`,
      );
      return;
    }

    console.log(
      `[MLConnectionTab] postMessage válido recebido: ${event.data?.type}`,
    );

    if (event.data?.type === "ML_OAUTH_SUCCESS") {
      setIsConnecting(false);
      setError(null); // ✅ Limpar erro anterior

      // ✅ Pequeno delay para garantir dados salvos no backend
      setTimeout(() => {
        fetchStatus();
      }, 500);
    } else if (event.data?.type === "ML_OAUTH_ERROR") {
      setIsConnecting(false);
      setError(event.data.message || "Erro na autenticação");
      console.error(`[MLConnectionTab] OAuth error: ${event.data.message}`);
    }
  };

  window.addEventListener("message", handleMessage);
  return () => window.removeEventListener("message", handleMessage);
}, [fetchStatus]);
```

---

## Priority 3: MÉDIO (Refactor Futuro)

---

### Correção 3.1: Migrar de Header `email` para Bearer Token

**Arquivo:** [app/middlewares/auth.middleware.ts](app/middlewares/auth.middleware.ts)

**Problema:**

```typescript
// ❌ MENOS SEGURO: email é PII (Personally Identifiable Information)
const apiEmail = request.headers["email"];
```

**Solução (futuro):**

```typescript
// ✅ MAIS SEGURO: Usar JWT Bearer token
const authHeader = request.headers.authorization;
const token = authHeader?.replace("Bearer ", "");

if (!token) {
  return reply.status(401).send({ message: "Authorization header required" });
}

try {
  const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET!);
  request.user = decoded as UserPayload;
} catch (error) {
  return reply.status(401).send({ message: "Token inválido" });
}
```

**Frontend (futuro):**

```typescript
// Obter token de NextAuth
const session = await getServerSession(authOptions);
const token = session?.accessToken;

// Enviar como Bearer
headers: {
  "Authorization": `Bearer ${token}`
}
```

---

## CHECKLIST DE IMPLEMENTAÇÃO

```
Implementações Obrigatórias (HOJE):
─────────────────────────────────────
[ ] 1.1 - Corrigir targetOrigin (usar window.opener.location.origin)
[ ] 1.2 - Remover polling (manter apenas postMessage)
[ ] 1.3 - Adicionar debouncing (useDebouncedCallback ou useRef)

Melhorias (Esta Semana):
─────────────────────────────────────
[ ] 2.1 - Adicionar try/catch no postMessage
[ ] 2.2 - Adicionar console.log para debug
[ ] 2.3 - Melhorar validação de origem no listener
[ ] Testar com ngrok + DevTools aberto

Refactor Futuro (Q2 2026):
─────────────────────────────────────
[ ] 3.1 - Migrar para Bearer token JWT
[ ] Adicionar testes unitários
[ ] Adicionar testes de integração (E2E)
```

---

## TESTING PLAN

### Test 1: localStorage Dev (UM CLICK)

```bash
# Terminal 1
npm run dev  # Frontend em http://localhost:3000

# Terminal 2
npm run api  # Backend em http://localhost:3333

# Browser
1. http://localhost:3000/integracoes/mercado-livre
2. Abrir DevTools (F12)
3. Console na tab
4. Clicar "Conectar Mercado Livre"
5. No popup, procurar por: "Desculpe, esta aplicação não pode ser carregada"
   (Porque ML vai rejeitar localhost como REDIRECT_URI)

RESULTADO ESPERADO:
- postMessage logger mostra evento
- Sem erro "origins não combinam"
- fetchStatus() chamada apenas 1x
- Status atualiza em ~500ms
```

### Test 2: Com ngrok (COM CREDENCIAIS ML)

```bash
# Terminal 1
npx ngrok http 3333  # Expõe backend, ex: https://abc123.ngrok-free.app

# Terminal 2
npm run dev  # Frontend em http://localhost:3000

# Configurar variáveis de ambiente
# .env.local:
NEXT_PUBLIC_API_URL=https://abc123.ngrok-free.app

# Terminal 3
npm run api  # Backend que ngrok expõe

# Browser
1. http://localhost:3000/integracoes/mercado-livre
2. Abrir DevTools (F12) → Console + Network
3. Clicar "Conectar Mercado Livre"
4. Procurar pelos logs:

LOGS ESPERADOS (SUCCESS):
[MLConnectionTab] postMessage recebido
  Origin: https://abc123.ngrok-free.app
  Current Origin: http://localhost:3000
  Type: ML_OAUTH_SUCCESS

LOGS ESPERADOS (FAILURE - antes da correção):
❌ Nenhum postMessage recebido
❌ fetchStatus() chamada após ~650ms (polling)

APÓS CORREÇÃO:
✅ postMessage recebido imediatamente
✅ fetchStatus() chamada em ~100ms
✅ Status atualiza em ~500ms total
```

---

## RESUMO DAS ALTERAÇÕES

| Arquivo                 | Linhas  | Tipo          | Severidade |
| ----------------------- | ------- | ------------- | ---------- |
| `callback/page.tsx`     | 74      | Lógica        | 🔴 CRÍTICO |
| `ml-connection-tab.tsx` | 155-185 | Lógica        | 🔴 CRÍTICO |
| `ml-connection-tab.tsx` | 48-80   | Feature       | 🔴 CRÍTICO |
| `callback/page.tsx`     | 70-80   | Logs          | ⚠️ ALTO    |
| `ml-connection-tab.tsx` | 211-230 | Feature       | ⚠️ ALTO    |
| Various                 | -       | JWT Migration | 🟡 MÉDIO   |

**Tempo estimado:**

- Implementação Priority 1: 30-45 minutos
- Testing: 20-30 minutos
- Priority 2: 15-20 minutos

**Total: ~90 minutos para fluxo funcional**
