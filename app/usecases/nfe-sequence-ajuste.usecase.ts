import { NumeracaoError } from "../fiscal/numeracao/numeracao.errors";
import {
  NfeSequenceService,
  type SequenceEmitterOpts,
} from "../fiscal/sequence/nfe-sequence.service";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { SystemLogService } from "../services/system-log.service";
import type { CompanyFiscalConfig } from "../interfaces/company-fiscal.interface";
import type { FiscalAmbiente } from "../fiscal/domain/nfe.types";

/**
 * Ajuste manual do próximo número de uma série (NfeSequence).
 *
 * POR QUE EXISTE
 * --------------
 * Cliente que migrou de outro sistema fiscal chega com o contador do Dexo
 * ABAIXO da numeração que o CNPJ já usou na SEFAZ. A partir daí toda emissão
 * leva 539/562/613 ("número já usado por outra chave") e, depois de 3
 * duplicidades seguidas, a numeração V2 tranca a série com
 * `SEQUENCIA_ATRAS_DA_SEFAZ` — cuja mensagem manda "ponha o próximo número da
 * série em N ou mais" (numeracao.service.ts, guard das 3 CONSUMIDO_EXTERNO).
 * Até 09/2026 esse botão não existia: mover `NfeSequence.proximoNumero` só
 * acontecia pelo import de pacote, pela inutilização ACEITA — ou por SQL em
 * produção, feito à mão. Este caso de uso é o caminho no produto: restrito ao
 * tenant, com escopo de emitente explícito, confirmação humana e auditoria.
 *
 * O QUE ELE NÃO FAZ
 * -----------------
 * Não reimplementa a regra de "só avança": quem escreve é o
 * `NfeSequenceService.ajustarProximoNumero`, o MESMO que a inutilização usa, e
 * é ele quem relê o contador e recusa `novo <= atual` — então nem uma leitura
 * velha aqui consegue fazer o número retroceder. A checagem daqui existe para
 * a mensagem e para o "quantos números serão pulados" da confirmação.
 *
 * E não existe caminho separado para a numeração V2: o contador da V2 é a
 * MESMA linha de `NfeSequence` (ver `lockSequencia` em numeracao.repository.ts,
 * que faz `SELECT ... FROM "NfeSequence"` com o mesmo filtro por emitente).
 * Escrever aqui é exatamente o que satisfaz o critério do guard
 * (`proximoNumero >= maiorBloqueante + 2`) e destrava a série.
 */
export interface AjusteProximoNumeroInput {
  /** Emitente da série. Ausente/null = CNPJ padrão do tenant (como nas vizinhas). */
  companyFiscalConfigId?: string | null;
  /** Obrigatório e explícito: produção e homologação têm contadores separados. */
  ambiente: string;
  /** Obrigatório e explícito: 55 (NF-e) e 65 (NFC-e) têm contadores separados. */
  modelo: string;
  serie: number;
  /** Novo próximo número a ser emitido nesta série. */
  proximoNumero: number;
  /** Texto livre que vai para a auditoria — quem pediu e com base em quê. */
  motivo: string;
  /** Segundo passo: sem `true`, o caso de uso responde 409 e NÃO escreve. */
  confirmar?: boolean;
}

/** Contexto do REQUEST (quem clicou, de onde) — só alimenta a auditoria. */
export interface AjusteProximoNumeroContexto {
  atorUserId?: string | null;
  ipAddress?: string;
  userAgent?: string;
}

export interface AjusteProximoNumeroResult {
  companyFiscalConfigId: string;
  /** CNPJ do emitente cujo contador foi movido — o escopo, em forma legível. */
  emitenteDocumento: string | null;
  ambiente: FiscalAmbiente;
  modelo: "55" | "65";
  serie: number;
  proximoNumeroAnterior: number;
  proximoNumero: number;
  numerosPulados: number;
  motivo: string;
  ajustadoEm: string;
}

const AMBIENTES: FiscalAmbiente[] = ["HOMOLOGACAO", "PRODUCAO"];
const MODELOS = ["55", "65"] as const;
/** Mesma régua da justificativa de inutilização (SEFAZ): 15 caracteres. */
const MOTIVO_MIN = 15;
const MOTIVO_MAX = 500;
/** nNF tem 9 dígitos na chave de acesso — mesmo teto do guard da V2. */
const NUMERO_MAX = 999999999;

/** Entrada malformada: 400 (mesmo status das vizinhas) + código para a UI. */
function entradaInvalida(campo: string, mensagem: string): never {
  throw new NumeracaoError("AJUSTE_ENTRADA_INVALIDA", 400, mensagem, { campo });
}

const legivel = (a: FiscalAmbiente) =>
  a === "PRODUCAO" ? "produção" : "homologação";

export class NfeSequenceAjusteUseCase {
  private configRepo: CompanyFiscalRepository;
  private sequenceService: NfeSequenceService;

  // Injeção opcional no estilo do CompanyFiscalUseCase — o caminho de produção
  // continua sendo `new NfeSequenceAjusteUseCase()`.
  constructor(
    configRepo?: CompanyFiscalRepository,
    sequenceService?: NfeSequenceService,
  ) {
    this.configRepo = configRepo ?? new CompanyFiscalRepository();
    this.sequenceService = sequenceService ?? new NfeSequenceService();
  }

  async ajustar(
    userId: string,
    input: AjusteProximoNumeroInput,
    contexto: AjusteProximoNumeroContexto = {},
  ): Promise<AjusteProximoNumeroResult> {
    if (!userId) entradaInvalida("userId", "Usuário não encontrado");

    const ambiente = this.validarAmbiente(input.ambiente);
    const modelo = this.validarModelo(input.modelo);
    const serie = this.validarSerie(input.serie);
    const proximoNumero = this.validarNumero(input.proximoNumero);
    const motivo = this.validarMotivo(input.motivo);

    // ── Escopo por emitente (o pior erro possível aqui é mover o contador do
    // CNPJ errado). Escolha explícita inválida NÃO cai no padrão em silêncio —
    // mesma regra da inutilização e do preview de próximo número.
    const config = input.companyFiscalConfigId
      ? await this.configRepo.findByIdForUser(
          input.companyFiscalConfigId,
          userId,
        )
      : await this.configRepo.findByUserId(userId);
    if (!config) {
      throw input.companyFiscalConfigId
        ? new NumeracaoError(
            "EMITENTE_NAO_ENCONTRADO",
            404,
            "Empresa não encontrada",
          )
        : new NumeracaoError(
            "CONFIG_FISCAL_AUSENTE",
            409,
            "Configuração fiscal não encontrada",
          );
    }

    // `isDefaultConfig`: sem escolha explícita o config veio de `findByUserId`
    // = padrão POR DEFINIÇÃO (só ele pode adotar a linha legada com
    // companyFiscalConfigId NULL). Cópia fiel do que a inutilização faz.
    const seqOpts: SequenceEmitterOpts = {
      companyFiscalConfigId: config.id,
      isDefaultConfig: input.companyFiscalConfigId
        ? (config.isDefault ?? true)
        : true,
    };

    const anterior = await this.sequenceService.consultarProximoNumero(
      userId,
      ambiente,
      serie,
      modelo,
      seqOpts,
    );

    // ── SÓ AVANÇA. Igualdade também é recusada: reajustar para o valor atual
    // não corrige nada e, na V2, não destravaria o guard (que exige
    // `proximoNumero >= maiorBloqueante + 2`) — daria a ilusão de conserto.
    if (proximoNumero <= anterior) {
      throw new NumeracaoError(
        "SEQUENCIA_NAO_RETROCEDE",
        409,
        `O próximo número da série ${serie} (modelo ${modelo}, ${legivel(ambiente)}) já está em ${anterior}: o contador só avança, nunca volta — número já usado não pode ser emitido de novo. Informe um número maior que ${anterior}.`,
        {
          companyFiscalConfigId: config.id,
          ambiente,
          modelo,
          serie,
          proximoNumeroAtual: anterior,
          proximoNumeroSolicitado: proximoNumero,
        },
      );
    }

    const numerosPulados = proximoNumero - anterior;

    // ── Confirmação humana. O efeito é irreversível: os números pulados viram
    // lacuna na numeração e, em produção, lacuna se resolve com inutilização
    // junto à SEFAZ. Mesmo desenho do NUMERACAO_CONFIRMAR_DESCARTE (409 + code
    // + detalhes), que o front já sabe tratar.
    if (input.confirmar !== true) {
      throw new NumeracaoError(
        "NUMERACAO_CONFIRMAR_AJUSTE",
        409,
        `O próximo número da série ${serie} (modelo ${modelo}, ${legivel(ambiente)}, CNPJ ${config.cnpj || "—"}) passará de ${anterior} para ${proximoNumero}: ${numerosPulados} número(s) ficarão sem uso e essa lacuna pode exigir inutilização junto à SEFAZ. O contador nunca retrocede — isto não pode ser desfeito. Confirme para aplicar.`,
        {
          companyFiscalConfigId: config.id,
          emitenteDocumento: config.cnpj ?? null,
          ambiente,
          modelo,
          serie,
          proximoNumeroAtual: anterior,
          proximoNumeroSolicitado: proximoNumero,
          numerosPulados,
          // Em homologação a lacuna não precisa de inutilização — o aviso
          // continua, mas a UI pode escolher o tom pelo campo.
          requerInutilizacao: ambiente === "PRODUCAO",
        },
      );
    }

    // ── Escrita. `ajustarProximoNumero` relê o contador e recusa `novo <=
    // atual` por conta própria: é ELE quem garante a monotonicidade, não a
    // leitura acima.
    // Corrida real: entre a revisão e o "Confirmar", uma emissão pode ter passado
    // o contador à frente do número pedido. O serviço recusa (nada é escrito), mas
    // com um Error cru — que a rota devolveria como 500 sem `code`, e a tela cairia
    // no aviso genérico. Traduz para o MESMO 409 do contrato, relendo o valor atual.
    try {
      await this.sequenceService.ajustarProximoNumero(
        userId,
        ambiente,
        serie,
        proximoNumero,
        modelo,
        seqOpts,
      );
    } catch (error) {
      if (error instanceof NumeracaoError) throw error;
      const msg = error instanceof Error ? error.message : "";
      if (!/deve ser maior que o atual/i.test(msg)) throw error;
      const agora = await this.sequenceService.consultarProximoNumero(
        userId,
        ambiente,
        serie,
        modelo,
        seqOpts,
      );
      throw new NumeracaoError(
        "SEQUENCIA_NAO_RETROCEDE",
        409,
        `O próximo número da série ${serie} (modelo ${modelo}, ${legivel(ambiente)}) avançou para ${agora} enquanto você confirmava — provavelmente uma nota foi emitida agora. Nada foi alterado. Informe um número maior que ${agora}.`,
        {
          companyFiscalConfigId: config.id,
          ambiente,
          modelo,
          serie,
          proximoNumeroAtual: agora,
          proximoNumeroSolicitado: proximoNumero,
        },
      );
    }

    const resultado: AjusteProximoNumeroResult = {
      companyFiscalConfigId: config.id,
      emitenteDocumento: config.cnpj ?? null,
      ambiente,
      modelo,
      serie,
      proximoNumeroAnterior: anterior,
      proximoNumero,
      numerosPulados,
      motivo,
      ajustadoEm: new Date().toISOString(),
    };

    await this.registrarAuditoria(userId, config, resultado, contexto);

    return resultado;
  }

  /**
   * Auditoria do ajuste.
   *
   * SINK: `SystemLog`. O `NfeAuditLog` — trilha natural do módulo fiscal — exige
   * `nfeId` (FK para NfeEmitida) e este evento não pertence a nota nenhuma: ele
   * é da SÉRIE. Criar tabela nova exigiria migration, e `prisma db push` é
   * proibido neste projeto. O `SystemLog` já é o sink das outras ações
   * sensíveis sem documento próprio (movimentação de peças, remediações de
   * estoque) e tem `userId`, `resource/resourceId`, `details` e `createdAt` —
   * exatamente quem/onde/o quê/quando.
   *
   * O `loggingMiddleware` global NÃO cobre esta rota: `determineActionType`
   * devolve null para um POST em /fiscal que não é emission/draft/inutilizacao
   * (e o ramo /config é PUT|POST em outro caminho). Ou seja: sem este registro
   * explícito, o ajuste seria invisível.
   *
   * Nomes de campo escolhidos para sobreviver ao `sanitizeDeep` (que redige por
   * SUBSTRING): por isso `emitenteDocumento`, e não `cnpj`.
   */
  private async registrarAuditoria(
    userId: string,
    config: CompanyFiscalConfig,
    r: AjusteProximoNumeroResult,
    contexto: AjusteProximoNumeroContexto,
  ): Promise<void> {
    const mensagem = `Próximo número da série ${r.serie} (modelo ${r.modelo}, ${legivel(r.ambiente)}, CNPJ ${r.emitenteDocumento || "—"}) ajustado de ${r.proximoNumeroAnterior} para ${r.proximoNumero} (${r.numerosPulados} pulado(s)): ${r.motivo}`;

    // A escrita no contador JÁ ACONTECEU. Se a auditoria rejeitasse, a rejeição
    // subiria para a rota e devolveria 500 para um ajuste que deu certo — e o
    // operador repetiria a operação (pulando mais números ainda). Mesmo
    // cuidado do POST /locations/move-products: `Promise.resolve(...).catch()`,
    // porque o retorno pode não ser promessa quando o serviço está mockado.
    await Promise.resolve(
      SystemLogService.logWarning("ADJUST_NFE_SEQUENCE", mensagem, {
        // QUEM: o usuário que clicou (colaborador tem id próprio). O tenant
        // dono dos dados vai no details, para a busca por qualquer um dos dois.
        userId: contexto.atorUserId ?? userId,
        resource: "NfeSequence",
        resourceId: config.id,
        details: {
          tenantUserId: userId,
          atorUserId: contexto.atorUserId ?? userId,
          companyFiscalConfigId: config.id,
          emitenteDocumento: r.emitenteDocumento,
          emitenteRazaoSocial: config.razaoSocial ?? null,
          emitentePadrao: config.isDefault ?? null,
          ambiente: r.ambiente,
          modelo: r.modelo,
          serie: r.serie,
          proximoNumeroAnterior: r.proximoNumeroAnterior,
          proximoNumero: r.proximoNumero,
          numerosPulados: r.numerosPulados,
          motivo: r.motivo,
          requerInutilizacao: r.ambiente === "PRODUCAO",
          ajustadoEm: r.ajustadoEm,
        },
        ipAddress: contexto.ipAddress,
        userAgent: contexto.userAgent,
      }),
    ).catch(() => {
      // Auditoria nunca muda a resposta ao operador (o SystemLogService já
      // registra a falha no console).
    });
  }

  private validarAmbiente(valor: unknown): FiscalAmbiente {
    const normalizado =
      typeof valor === "string" ? valor.trim().toUpperCase() : "";
    if (!AMBIENTES.includes(normalizado as FiscalAmbiente)) {
      entradaInvalida(
        "ambiente",
        "Ambiente inválido — informe HOMOLOGACAO ou PRODUCAO",
      );
    }
    return normalizado as FiscalAmbiente;
  }

  private validarModelo(valor: unknown): "55" | "65" {
    const normalizado = typeof valor === "number" ? String(valor) : valor;
    if (
      typeof normalizado !== "string" ||
      !MODELOS.includes(normalizado.trim() as "55" | "65")
    ) {
      entradaInvalida("modelo", "Modelo inválido — informe 55 (NF-e) ou 65 (NFC-e)");
    }
    return (normalizado as string).trim() as "55" | "65";
  }

  private validarSerie(valor: unknown): number {
    // Mesma faixa do preview (GET /fiscal/nfe/proximo-numero) e do guard da V2.
    if (!Number.isInteger(valor) || (valor as number) < 0 || (valor as number) > 999) {
      entradaInvalida("serie", "Série inválida (0–999).");
    }
    return valor as number;
  }

  private validarNumero(valor: unknown): number {
    if (
      !Number.isInteger(valor) ||
      (valor as number) < 1 ||
      (valor as number) > NUMERO_MAX
    ) {
      entradaInvalida(
        "proximoNumero",
        `Próximo número inválido — informe um inteiro entre 1 e ${NUMERO_MAX}.`,
      );
    }
    return valor as number;
  }

  private validarMotivo(valor: unknown): string {
    const motivo = typeof valor === "string" ? valor.trim() : "";
    if (motivo.length < MOTIVO_MIN) {
      entradaInvalida(
        "motivo",
        `Motivo obrigatório (mínimo ${MOTIVO_MIN} caracteres) — ele fica registrado na auditoria.`,
      );
    }
    if (motivo.length > MOTIVO_MAX) {
      entradaInvalida(
        "motivo",
        `Motivo muito longo (máximo ${MOTIVO_MAX} caracteres).`,
      );
    }
    return motivo;
  }
}
