/**
 * Script de teste para webhook de pedidos do Mercado Livre
 * Testa o endpoint POST /marketplace/ml/webhook
 */

const API_BASE_URL = process.env.APP_BACKEND_URL || "http://localhost:3333";

/**
 * Payload de exemplo de webhook do ML para pedido
 */
const sampleOrderWebhookPayload = {
  resource: "/orders/123456789",
  user_id: 123456789, // Este ID deve existir no banco como externalUserId
  topic: "orders_v2",
  application_id: 123456789,
  attempts: 1,
  sent: new Date().toISOString(),
  received: new Date().toISOString(),
};

/**
 * Payload inválido para teste de validação
 */
const invalidWebhookPayload = {
  resource: "/orders/invalid",
  user_id: "not_a_number",
  topic: "invalid_topic",
  attempts: "not_a_number",
};

/**
 * Testa o endpoint de webhook
 */
async function testWebhook() {
  console.log("🧪 Testando endpoint de webhook do Mercado Livre");
  console.log("=".repeat(50));

  try {
    // 1. Teste com payload inválido
    console.log("\n1. Testando payload inválido...");
    const invalidResponse = await fetch(
      `${API_BASE_URL}/marketplace/ml/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invalidWebhookPayload),
      },
    );

    const invalidResult = await invalidResponse.json();
    console.log(`Status: ${invalidResponse.status}`);
    console.log("Resposta:", invalidResult);

    if (invalidResponse.status === 400) {
      console.log("✅ Validação de payload inválido funcionando");
    } else {
      console.log("❌ Validação não funcionou como esperado");
    }

    // 2. Teste com payload válido (mas user_id pode não existir)
    console.log("\n2. Testando payload válido...");
    const validResponse = await fetch(
      `${API_BASE_URL}/marketplace/ml/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sampleOrderWebhookPayload),
      },
    );

    const validResult = await validResponse.json();
    console.log(`Status: ${validResponse.status}`);
    console.log("Resposta:", validResult);

    if (validResponse.status === 200) {
      if (validResult.success) {
        console.log("✅ Webhook processado com sucesso");
      } else {
        console.log(
          "⚠️  Webhook processado mas com erro (provavelmente user_id não encontrado)",
        );
      }
    } else {
      console.log("❌ Erro no processamento do webhook");
    }
  } catch (error) {
    console.error("❌ Erro no teste:", error.message);
  }

  console.log("\n" + "=".repeat(50));
  console.log("📝 Notas:");
  console.log("- Para testar completamente, conecte uma conta do ML primeiro");
  console.log(
    "- O user_id no payload deve corresponder ao externalUserId da conta",
  );
  console.log("- Crie um pedido real no ML para testar o fluxo completo");
}

// Executar teste
if (require.main === module) {
  testWebhook();
}

module.exports = { testWebhook };
