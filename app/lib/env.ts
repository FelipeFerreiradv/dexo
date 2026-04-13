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

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  DIRECT_URL: z.string().min(1, "DIRECT_URL é obrigatória"),

  // NextAuth
  NEXTAUTH_SECRET: z
    .string()
    .min(16, "NEXTAUTH_SECRET precisa ter ao menos 16 caracteres"),
  NEXTAUTH_URL: optionalUrlIsh,

  // Mercado Livre
  ML_CLIENT_ID: z.string().min(1, "ML_CLIENT_ID é obrigatória"),
  ML_CLIENT_SECRET: z.string().min(1, "ML_CLIENT_SECRET é obrigatória"),
  ML_AUTH_URL: urlIsh,
  ML_API_URL: urlIsh,

  // Shopee
  SHOPEE_PARTNER_ID: z.string().min(1, "SHOPEE_PARTNER_ID é obrigatória"),
  SHOPEE_PARTNER_KEY: z.string().min(1, "SHOPEE_PARTNER_KEY é obrigatória"),
  SHOPEE_SANDBOX: z.enum(["true", "false"]).optional().default("false"),

  // URLs
  APP_BACKEND_URL: urlIsh,
  NEXT_PUBLIC_API_URL: urlIsh,
  CORS_ORIGIN: optionalUrlIsh,

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
