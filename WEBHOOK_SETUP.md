# Configuração de Webhooks - Sub-phase 5.3

## Visão Geral

A Sub-phase 5.3 implementa **sincronização avançada com webhooks** do Mercado Livre, permitindo processamento automático e em tempo real de pedidos.

## Funcionalidades Implementadas

### 1. Endpoint de Webhook

- **Rota**: `POST /marketplace/ml/webhook`
- **Autenticação**: Não requer (validação via `application_id`)
- **Processamento**: Automático de notificações de pedidos

### 2. Tipos de Webhook Suportados

- `orders_v2`: Notificações de pedidos (principal)
- Estrutura preparada para outros tipos (`items`, `messages`, etc.)

### 3. Processamento Automático

- Identificação do usuário via `user_id` do Mercado Livre
- Importação automática de pedidos
- Desconto automático de estoque
- Logs de sincronização

## Como Configurar Webhooks no Mercado Livre

### 1. Acesse o Painel do Desenvolvedor

1. Vá para [Mercado Livre Developers](https://developers.mercadolivre.com.br/)
2. Faça login com sua conta
3. Acesse "Meus Aplicativos"

### 2. Configure o Webhook

1. No seu aplicativo, vá para "Webhooks"
2. Adicione um novo webhook:
   - **URL**: `https://seudominio.com/marketplace/ml/webhook`
   - **Tópicos**: Selecione `orders`
   - **Eventos**: Todos os eventos de pedidos

### 3. Para Desenvolvimento Local

Use ngrok para expor sua porta local:

```bash
npx ngrok http 3333
```

Configure a URL do ngrok como webhook URL no painel do ML.

## Fluxo de Processamento

```
1. ML envia notificação → 2. Validação do payload → 3. Identificação do usuário →
4. Importação do pedido → 5. Desconto de estoque → 6. Log de sincronização
```

## Testes

### Teste Básico

```bash
# Payload inválido (deve retornar erro 400)
curl -X POST http://localhost:3333/marketplace/ml/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "invalid"}'

# Payload válido (procura conta ML)
curl -X POST http://localhost:3333/marketplace/ml/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "resource": "/orders/123456789",
    "user_id": 123456789,
    "topic": "orders_v2",
    "application_id": 123456789,
    "attempts": 1,
    "sent": "2024-01-01T00:00:00.000Z",
    "received": "2024-01-01T00:00:00.000Z"
  }'
```

### Teste Automatizado

```bash
node scripts/integration/test_webhook.js
```

## Estrutura de Arquivos

```
app/
├── marketplaces/
│   ├── types/
│   │   └── ml-order.types.ts          # Tipos de webhook
│   ├── usecases/
│   │   └── webhook.usercase.ts       # Processamento de webhooks
│   └── repositories/
│       └── marketplace.repository.ts # Busca por externalUserId
├── routes/
│   └── marketplace.routes.ts         # Rota /ml/webhook
└── scripts/
    └── integration/
        └── test_webhook.js           # Script de teste
```

## Considerações de Segurança

- Webhooks não requerem autenticação (padrão do ML)
- Validação rigorosa do payload
- Processamento assíncrono para evitar timeouts
- Logs detalhados para auditoria

## Próximos Passos

1. **Configurar webhook no painel do ML**
2. **Testar com pedidos reais**
3. **Monitorar logs de processamento**
4. **Implementar retry logic se necessário**
5. **Adicionar métricas de performance**

## Troubleshooting

### Webhook não está sendo chamado

- Verifique se a URL está acessível publicamente
- Confirme se o tópico `orders` está selecionado
- Verifique logs do ML no painel do desenvolvedor

### Erro "Conta não encontrada"

- Certifique-se de que uma conta ML está conectada
- Verifique se o `user_id` no webhook corresponde ao `externalUserId` da conta

### Pedidos não sendo importados

- Verifique se há produtos vinculados por SKU
- Confirme se o pedido está no status "paid"
- Verifique logs de erro no banco de dados
