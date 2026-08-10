import { z } from "zod";

/**
 * Schema de variáveis de ambiente validado no boot.
 *
 * Importar este módulo PRIMEIRO no entrypoint (após `dotenv.config()`) garante
 * que o processo falhe imediatamente se alguma var obrigatória estiver
 * ausente ou mal-formada — o que é bem melhor do que descobrir isso
 * quando a primeira requisição bate no marketplace e explode.
 */
const urlIsh = z
  .string()
  .min(1)
  .refine((v) => /^https?:\/\//.test(v), {
    message: "deve começar com http:// ou https://",
  });

const optionalUrlIsh = z
  .string()
  .optional()
  .refine((v) => v === undefined || v === "" || /^https?:\/\//.test(v), {
    message: "deve começar com http:// ou https://",
  });

/** Provedores de IA aceitos. Espelha `AiProviderName` de ai-constants.ts. */
const PROVEDORES_DE_IA = ["gemini", "deepseek", "mock"] as const;

/**
 * Rota de capacidade do Bitz: `"provedor:modelo"`, opcional.
 *
 * ⭐ VALIDA O PROVEDOR NO BOOT, e essa é a razão de existir. A casa já barra
 * `AI_PROVIDER` desconhecido aqui — há teste chamado "typo não vira mock
 * silencioso". A superfície de rota é nova e precisa da MESMA barreira: no
 * runtime, nome não reconhecido cai no provedor mock, e um mock em produção
 * responde `Bitz (mock): recebi "..."` com `ok:true`, debita a cota do dia e
 * não escreve nada em lugar nenhum. Falha aberta e silenciosa, para um cliente
 * pagante.
 *
 * O MODELO não é validado: é string livre por natureza, e nomes mudam com
 * frequência (o `deepseek-chat` foi descontinuado em 24/07/2026). Modelo
 * ausente já é tratado em runtime, com `sem_modelo`.
 */
function rotaDeCapacidade(nome: string) {
  return z
    .string()
    .optional()
    .refine(
      (v) => {
        if (v === undefined || v.trim() === "") return true;
        const provedor = v.split(":")[0].trim().toLowerCase();
        return (PROVEDORES_DE_IA as readonly string[]).includes(provedor);
      },
      {
        message: `${nome} deve ser "provedor:modelo" com provedor em ${PROVEDORES_DE_IA.join("|")}`,
      },
    );
}

/**
 * Inteiro positivo opcional que permanece STRING no tipo de saída.
 *
 * Diferente de RATE_LIMIT_MAX/PORT (que usam `.transform(Number)`), aqui não
 * transformamos de propósito: quem consome estes valores lê `process.env`
 * diretamente por função (ai-constants.ts), para que um `.env` editado +
 * `pm2 restart` valha sem rebuild. O papel do schema é só barrar lixo no boot.
 */
const positiveIntString = (name: string) =>
  z
    .string()
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        v === "" ||
        (Number.isInteger(Number(v)) && Number(v) > 0),
      { message: `${name} deve ser inteiro positivo` },
    );

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  DIRECT_URL: z.string().min(1, "DIRECT_URL é obrigatória"),

  // NextAuth
  NEXTAUTH_SECRET: z
    .string()
    .min(16, "NEXTAUTH_SECRET precisa ter ao menos 16 caracteres"),
  NEXTAUTH_URL: optionalUrlIsh,

  // PR-A2 — token de API. API_JWT_SECRET opcional (fallback p/ NEXTAUTH_SECRET).
  // API_AUTH_MODE: "legacy" (default, aceita token OU header email) ou "strict"
  // (só token). Subir em legacy = zero regressão; virar strict após o front
  // migrar para enviar o Bearer.
  API_JWT_SECRET: z
    .string()
    .min(16, "API_JWT_SECRET precisa ter ao menos 16 caracteres")
    .optional(),
  API_AUTH_MODE: z.enum(["legacy", "strict"]).optional().default("legacy"),

  // Mercado Livre
  ML_CLIENT_ID: z.string().min(1, "ML_CLIENT_ID é obrigatória"),
  ML_CLIENT_SECRET: z.string().min(1, "ML_CLIENT_SECRET é obrigatória"),
  ML_AUTH_URL: urlIsh,
  ML_API_URL: urlIsh,

  // Shopee
  SHOPEE_PARTNER_ID: z.string().min(1, "SHOPEE_PARTNER_ID é obrigatória"),
  SHOPEE_PARTNER_KEY: z.string().min(1, "SHOPEE_PARTNER_KEY é obrigatória"),
  SHOPEE_SANDBOX: z.enum(["true", "false"]).optional().default("false"),

  // Magalu (ID Magalu / Grupo Magalu). TODAS opcionais de propósito: a
  // integração fica atrás da flag NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED e
  // env.ts é exit-on-error — vars obrigatórias ausentes derrubariam o boot
  // (mesmo padrão de REMBG_*/MARKETPLACE_TOKEN_ENC_KEY). Os serviços magalu-*
  // validam a presença em runtime (validateMagaluConfig).
  MAGALU_CLIENT_ID: z.string().optional(),
  MAGALU_CLIENT_SECRET: z.string().optional(),
  MAGALU_AUTH_URL: optionalUrlIsh,
  MAGALU_API_URL: optionalUrlIsh,
  MAGALU_REDIRECT_URI: optionalUrlIsh,
  // Escopos OAuth separados por espaço. Sem valor → usa o default das constantes.
  MAGALU_SCOPES: z.string().optional(),
  // Segredo whsec_* devolvido por PUT /v1/onboarding/signup (assinatura do webhook).
  MAGALU_WEBHOOK_SECRET: z.string().optional(),
  MAGALU_SANDBOX: z.enum(["true", "false"]).optional().default("false"),

  // WhatsApp (Cloud API oficial da Meta). TODAS opcionais de propósito, mesmo
  // padrão do bloco Magalu acima: o módulo fica atrás da flag
  // NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED + gate por usuário, e env.ts é
  // exit-on-error. Os serviços whatsapp-* validam em runtime
  // (validateWhatsAppConfig — que também exige MARKETPLACE_TOKEN_ENC_KEY,
  // pois o token da conta é criptografado em repouso).
  WHATSAPP_APP_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_API_VERSION: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === "" || /^v\d+\.\d+$/.test(v), {
      message: "WHATSAPP_API_VERSION deve ter o formato vNN.N (ex.: v25.0)",
    }),
  WHATSAPP_GRAPH_BASE_URL: optionalUrlIsh,
  // Token do handshake GET do webhook (string secreta que nós definimos).
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  // Configuration ID do Embedded Signup (fase futura; MVP é onboarding manual).
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional(),

  // Bitz (agente de IA). TODAS opcionais de propósito, mesmo padrão dos blocos
  // Magalu e WhatsApp acima: o módulo fica atrás da flag
  // NEXT_PUBLIC_AI_MODULE_ENABLED + gate por usuário (User.aiEnabledAt), e
  // env.ts é exit-on-error. Sem AI_API_KEY a API sobe NORMALMENTE e todo o
  // resto do sistema funciona igual — só o Bitz reporta indisponibilidade.
  // A validação de runtime é describeAiConfigProblem() (ai-constants.ts), que
  // DEVOLVE o motivo em vez de lançar: quem chama precisa degradar, não quebrar.
  AI_PROVIDER: z.enum(["gemini", "deepseek", "mock"]).optional(),
  AI_MODEL: z.string().optional(),
  // NUNCA em NEXT_PUBLIC_*: a chave só existe no servidor.
  AI_API_KEY: z.string().optional(),
  // Chaves POR PROVEDOR — é o que permite dois provedores ao mesmo tempo.
  // ⚠️ Um provedor NUNCA herda a chave de outro: `AI_API_KEY` só vale para o
  // provedor nomeado em `AI_PROVIDER` (ver getAiApiKeyFor em ai-constants.ts).
  AI_GEMINI_API_KEY: z.string().optional(),
  AI_DEEPSEEK_API_KEY: z.string().optional(),
  // ⭐ ROTA POR CAPACIDADE, no formato "provedor:modelo".
  //
  // Validadas AQUI, no boot, pelo mesmo motivo que `AI_PROVIDER` é: typo não
  // pode virar mock silencioso. Sem esta barreira,
  // `AI_ROUTE_TEXTO="deepsek:v4"` sobe a API, o cliente pergunta, recebe
  // `Bitz (mock): recebi "..."` como se fosse resposta de verdade, e ainda tem
  // a cota do dia debitada — falha ABERTA, sem nada no log.
  AI_ROUTE_TEXTO: rotaDeCapacidade("AI_ROUTE_TEXTO"),
  AI_ROUTE_IMAGEM: rotaDeCapacidade("AI_ROUTE_IMAGEM"),
  AI_ROUTE_AUDIO: rotaDeCapacidade("AI_ROUTE_AUDIO"),
  AI_GEMINI_BASE_URL: optionalUrlIsh,
  AI_DEEPSEEK_BASE_URL: optionalUrlIsh,
  AI_TIMEOUT_MS: positiveIntString("AI_TIMEOUT_MS"),
  AI_MAX_TOKENS: positiveIntString("AI_MAX_TOKENS"),
  AI_MAX_DAILY_PER_TENANT: positiveIntString("AI_MAX_DAILY_PER_TENANT"),
  // Teto diário de TRANSCRIÇÕES por tenant (Fase 7). Contador próprio: gravar
  // duas ou três vezes até sair direito é normal e não pode gastar mensagens.
  AI_MAX_DAILY_AUDIO_PER_TENANT: positiveIntString(
    "AI_MAX_DAILY_AUDIO_PER_TENANT",
  ),
  AI_MAX_DAILY_GLOBAL: positiveIntString("AI_MAX_DAILY_GLOBAL"),
  AI_TEMPERATURE: z
    .string()
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        v === "" ||
        (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 2),
      { message: "AI_TEMPERATURE deve ser um número entre 0 e 2" },
    ),

  // URLs
  APP_BACKEND_URL: urlIsh,
  NEXT_PUBLIC_API_URL: urlIsh,
  CORS_ORIGIN: optionalUrlIsh,

  // Cifra de tokens de marketplace em repouso (PR-A5). OPCIONAL: sem ela, a
  // cifra fica desligada (tokens em texto plano, comportamento atual). Quando
  // presente, deve ser 64 chars hex (32 bytes). Ativar só após validar em
  // staging (ver RELATORIO_SEGURANCA_DIAGNOSTICO.md).
  MARKETPLACE_TOKEN_ENC_KEY: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === "" || /^[0-9a-fA-F]{64}$/.test(v), {
      message: "MARKETPLACE_TOKEN_ENC_KEY deve ter 64 chars hex (32 bytes)",
    }),

  // Rate limit da API (PR-A4). Opcional; default 300 req/min por IP.
  RATE_LIMIT_MAX: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (Number.isInteger(v) && v > 0), {
      message: "RATE_LIMIT_MAX deve ser inteiro positivo",
    }),

  // CORS_ORIGIN: obrigatório em produção é validado no boot da API (api.ts);
  // aqui permanece opcional para não quebrar dev/test.

  // Runtime
  PORT: z
    .string()
    .optional()
    .default("3333")
    .transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n > 0 && n < 65536, {
      message: "PORT deve ser um inteiro entre 1 e 65535",
    }),

  // Optional tuning knobs — validar só se presentes.
  ML_MAX_DIM_CM: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (Number.isFinite(v) && v > 0), {
      message: "ML_MAX_DIM_CM deve ser número positivo",
    }),
  ML_MAX_WEIGHT_KG: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (Number.isFinite(v) && v > 0), {
      message: "ML_MAX_WEIGHT_KG deve ser número positivo",
    }),

  // Remoção de fundo (sidecar Python). Todos opcionais — sem
  // REMBG_SIDECAR_URL ou com REMBG_ENABLED=false, o pipeline de
  // upload faz fallback graceful (otimiza, mas não remove fundo).
  REMBG_SIDECAR_URL: optionalUrlIsh,
  REMBG_TIMEOUT_MS: z
    .string()
    .optional()
    // Default 60s: BiRefNet ~7s/img em CPU; em upload de lote a fila no
    // sidecar (1 worker) faz as ultimas esperarem — 60s cobre com folga.
    // Faixa permitida 1000–120000.
    .default("60000")
    .transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n >= 1000 && n <= 120000, {
      message: "REMBG_TIMEOUT_MS deve ser inteiro entre 1000 e 120000",
    }),
  REMBG_ENABLED: z.enum(["true", "false"]).optional().default("true"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("\n");
    const msg = `Configuração de ambiente inválida:\n${issues}\n\nConfira seu .env contra .env.example.`;
    throw new EnvValidationError(msg);
  }
  return parsed.data;
}

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

/**
 * Carrega e valida o env no boot. Se falhar, imprime a razão e sai com
 * código 1 — o processo NÃO fica meio-vivo.
 */
export function loadEnvOrExit(source: NodeJS.ProcessEnv = process.env): Env {
  try {
    return loadEnv(source);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      console.error(`\n[env] ${err.message}\n`);
    } else {
      console.error("[env] Erro inesperado carregando variáveis:", err);
    }
    process.exit(1);
  }
}
