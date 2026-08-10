// A MEMÓRIA DA LOJA. Fase 11.
//
// ⭐ A FRASE QUE GOVERNA O MÓDULO: memória guarda REGRA, nunca FATO.
//
//   regra  → "meu markup padrão é 2,2x"        vale hoje e daqui a seis meses
//   fato   → "o farol do Gol custa 180"        muda sozinho, e o banco sabe
//
// A diferença não é filosófica. Um fato guardado aqui entra no prompt de TODO
// turno e o modelo passa a respondê-lo de cabeça, com confiança, em vez de
// consultar — que é exatamente o comportamento que o resto deste agente inteiro
// existe para impedir ("NUNCA invente dado"). Uma memória errada é pior que
// memória nenhuma: ela contamina toda conversa futura, e ninguém percebe.
//
// Por isso a guarda deste arquivo é de ENTRADA, e não de saída.

/**
 * Teto de memórias por loja.
 *
 * ⚠️ NÃO É BUROCRACIA, É A CONTA DO PROMPT. Todas as memórias entram em TODO
 * turno de TODO usuário do tenant — não há seleção por relevância, de propósito
 * (uma regra que só se aplica quando casa palavra-chave é uma regra que falha em
 * silêncio justamente quando importa).
 *
 * 25 × 200 caracteres ≈ 5.000 caracteres ≈ 1.250 tokens de entrada por turno, no
 * pior caso. É o preço de o Bitz saber como a loja trabalha; o dobro disso já
 * começaria a competir com o histórico da conversa dentro da janela.
 */
export const MAX_MEMORIAS_POR_TENANT = 25;

/** Uma regra cabe numa frase. Ver a conta acima. */
export const MAX_CONTEUDO_CHARS = 200;

/** Abaixo disso não é regra, é ruído ("ok", "sim", "lembra"). */
export const MIN_CONTEUDO_CHARS = 8;

/**
 * As gavetas. VOCABULÁRIO FECHADO (`z.enum` na tool), e fechado de propósito:
 * tópico livre viraria 40 gavetas de uma palavra cada, inventadas pelo modelo,
 * e a tela de memórias deixaria de agrupar coisa nenhuma.
 */
export const TOPICOS_DE_MEMORIA = [
  "preco",
  "anuncio",
  "operacao",
  "vocabulario",
  "geral",
] as const;

export type AiMemoriaTopico = (typeof TOPICOS_DE_MEMORIA)[number];

/** Como o LOJISTA lê o tópico — no cartão e na tela. */
export const ROTULO_DO_TOPICO: Record<AiMemoriaTopico, string> = {
  preco: "Preço e margem",
  anuncio: "Anúncio e marketplace",
  operacao: "Operação da loja",
  vocabulario: "Jeito de falar",
  geral: "Geral",
};

export function ehTopico(v: unknown): v is AiMemoriaTopico {
  return (
    typeof v === "string" &&
    (TOPICOS_DE_MEMORIA as readonly string[]).includes(v)
  );
}

/** Uma memória, como a tela e o prompt a enxergam. */
export interface AiMemoria {
  id: string;
  topico: AiMemoriaTopico;
  conteudo: string;
  createdAt: Date;
}

export type MotivoDeRecusa =
  | "vazia"
  | "longa"
  | "documento"
  | "segredo"
  | "dado_que_muda"
  | "lotada";

export type ResultadoDaVerificacao =
  | { ok: true; conteudo: string }
  | { ok: false; motivo: MotivoDeRecusa; mensagem: string };

// ---------------------------------------------------------------------------
// AS GUARDAS DE ENTRADA
//
// ⚠️ TODAS SÃO POR FORMA, NUNCA POR INTENÇÃO. Não existe aqui uma lista de
// frases proibidas do tipo "ignore suas instruções", e a ausência é deliberada:
// bloquear por frase é jogo de gato e rato que dá uma sensação de segurança que
// a lista não sustenta — muda o idioma, muda o espaçamento, e passa.
//
// A defesa contra memória hostil é outra, e é estrutural: o conteúdo entra no
// prompt DENTRO de `<dados_do_sistema>`, neutralizado, e a moldura que diz como
// tratá-lo é texto NOSSO, fixo, do lado de fora do envelope. Uma memória que
// mande ignorar regras é lida como o que ela é — um dado esquisito que o
// lojista cadastrou —, não como ordem. Ver `REGRAS_DA_MEMORIA`.
//
// O que estas guardas pegam é outra coisa: dado que NÃO PODE ser guardado nem
// com a melhor das intenções.
// ---------------------------------------------------------------------------

/**
 * Documento e contato de pessoa (LGPD). Decisão do dono em 10/08/2026.
 *
 * Dado pessoal de terceiro tem lugar próprio no sistema, com trilha e controle
 * de acesso — não uma anotação livre do agente que viaja para o provedor de IA
 * em todo turno de todo usuário da loja. Continua tudo consultável pelas
 * ferramentas normais, que é onde ele deve ser lido.
 *
 * Os padrões são estreitos de propósito: exigem a FORMA do documento, não
 * qualquer sequência de dígitos. "meu markup é 2,2x" e "frete grátis acima de
 * R$ 300" passam; "(41) 99888-7777" e "123.456.789-00" não.
 */
const PADROES_DE_DOCUMENTO: RegExp[] = [
  // CPF: 123.456.789-00 / 123 456 789 00 / 12345678900
  /\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}(?!\d)/,
  // CNPJ: 12.345.678/0001-90
  /\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}(?!\d)/,
  // Telefone: (41) 99888-7777, 41 3333-4444, 41999887777
  /\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/,
  // CEP: exige o hífen — sem ele, 8 dígitos soltos são qualquer coisa.
  /\d{5}-\d{3}(?!\d)/,
  // E-mail.
  /[\w.+-]+@[\w-]+\.[\w.-]{2,}/,
];

/**
 * Credencial. NÃO estava na lista do dono e entrou por decisão de engenharia:
 * é da mesma família do documento e o risco é maior, porque a memória vai para
 * o provedor de IA em todo turno. Alguém vai tentar guardar a senha do Mercado
 * Livre para "o Bitz resolver sozinho" — e esse é o dia em que uma credencial
 * de marketplace passa a trafegar em toda conversa da loja.
 */
const PADRAO_DE_SEGREDO =
  /(senha|password|token|secret|api[\s_-]?key|chave\s+(de|da)\s+api|credencial)/i;

/**
 * Dado que envelhece. Decisão do dono em 10/08/2026.
 *
 * ⚠️ ESTA GUARDA ERRA PARA O LADO DE BARRAR, e a assimetria é escolhida: uma
 * memória barrada custa ao lojista reescrever a frase; uma memória de estoque
 * aceita custa o Bitz afirmar, seis meses depois, um número que não existe mais
 * — sem consultar, e sem ninguém desconfiar. A mensagem de recusa diz como
 * reescrever, então o caminho de volta é curto.
 */
const PADROES_DE_DADO_QUE_MUDA: RegExp[] = [
  // Um SKU é o endereço de UMA peça. Regra não fala de uma peça específica.
  /\bsku\b/i,
  // "estoque de 4 unidades", "saldo 12", "quantidade: 30"
  /(estoque|saldo|quantidade)[^.!?]{0,30}\d/i,
  // "4 unidades em estoque", "12 no estoque"
  /\d[^.!?]{0,30}(em estoque|no estoque|unidades?\b)/i,
];

/**
 * A porta de entrada da memória. Devolve o conteúdo normalizado ou a recusa,
 * com a mensagem que o LOJISTA lê.
 *
 * Roda em DOIS lugares e é a mesma função nos dois: na tool (antes de propor) e
 * no executor (antes de gravar). Não é redundância inútil — entre propor e
 * confirmar passam até 30 minutos, e o que grava tem que validar o que grava.
 */
export function verificarConteudo(bruto: unknown): ResultadoDaVerificacao {
  const conteudo = String(bruto ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (conteudo.length < MIN_CONTEUDO_CHARS) {
    return recusa(
      "vazia",
      "Essa memória está curta demais para significar alguma coisa. Escreva a regra em uma frase.",
    );
  }
  if (conteudo.length > MAX_CONTEUDO_CHARS) {
    return recusa(
      "longa",
      `Uma memória cabe em ${MAX_CONTEUDO_CHARS} caracteres. Se são duas regras, ensine uma de cada vez.`,
    );
  }
  if (PADROES_DE_DOCUMENTO.some((re) => re.test(conteudo))) {
    return recusa(
      "documento",
      "Não guardo CPF, CNPJ, telefone, e-mail nem endereço na memória. Dado de cliente fica no cadastro de Clientes, que é onde ele tem controle de acesso.",
    );
  }
  if (PADRAO_DE_SEGREDO.test(conteudo)) {
    return recusa(
      "segredo",
      "Não guardo senha, token nem chave de acesso. Credencial de marketplace se cadastra na tela de integração.",
    );
  }
  if (PADROES_DE_DADO_QUE_MUDA.some((re) => re.test(conteudo))) {
    return recusa(
      "dado_que_muda",
      "Isso é número que muda — estoque, saldo e peça eu consulto na hora, e guardar viraria uma resposta desatualizada. Se for uma REGRA da loja, escreva sem citar SKU nem quantidade.",
    );
  }

  return { ok: true, conteudo };
}

function recusa(
  motivo: MotivoDeRecusa,
  mensagem: string,
): ResultadoDaVerificacao {
  return { ok: false, motivo, mensagem };
}

/** Mensagem de loja cheia. Fica aqui para a tool e o executor dizerem o mesmo. */
export const MENSAGEM_DE_LOTADA = `Sua loja já tem ${MAX_MEMORIAS_POR_TENANT} memórias, que é o máximo. Apague uma que não vale mais em "O que eu sei da sua loja", no topo do chat, e me ensine de novo.`;
