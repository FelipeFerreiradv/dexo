"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";

/**
 * Gravação de voz do Bitz (Fase 7).
 *
 * ⭐ MÁQUINA DE ESTADOS EXPLÍCITA, e ela NUNCA pede o microfone na montagem.
 * Segue o precedente da casa (`app/scan/components/qr-camera.tsx`): permissão
 * de dispositivo só é pedida por gesto do usuário. Pedir no mount faz o
 * navegador mostrar o balão de permissão sozinho, o lojista nega por reflexo, e
 * a partir dali o recurso fica bloqueado no domínio — sem caminho de volta
 * dentro do app.
 *
 * ⚠️ DESLIGAR AS TRILHAS É OBRIGATÓRIO, não faxina. Um `MediaStream` vivo
 * mantém a luz do microfone acesa e o indicador de gravação na aba. Deixar
 * vazar é o tipo de coisa que o cliente vê e não perdoa.
 *
 * O áudio nunca toca disco: vai do gravador para o `fetch` e some. Ver
 * `app/ai/audio/transcricao.service.ts`.
 */
export type EstadoDoAudio =
  | "parado"
  | "pedindo"
  | "gravando"
  | "enviando"
  | "erro";

/** Tetos espelhados de `AI_CONSTANTS`. O servidor é quem manda; isto é UX. */
const MAX_SEGUNDOS = 90;

/**
 * Preferência de contêiner. O primeiro que o navegador souber gravar vence.
 *
 * Chrome e Firefox entregam webm/opus; o Safari só grava mp4/aac. Os dois são
 * aceitos inline pelo provedor, então não há transcodificação em lugar nenhum.
 */
const FORMATOS = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function escolherFormato(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return FORMATOS.find((f) => {
    try {
      return MediaRecorder.isTypeSupported(f);
    } catch {
      return false;
    }
  });
}

/** Mensagem que o usuário lê. Nunca o nome técnico do erro do navegador. */
function mensagemDoErro(err: unknown): string {
  const nome = (err as { name?: string })?.name ?? "";
  if (nome === "NotAllowedError" || nome === "SecurityError") {
    return "Preciso da sua permissão para usar o microfone. Libere nas configurações do navegador e tente de novo.";
  }
  if (nome === "NotFoundError" || nome === "DevicesNotFoundError") {
    return "Não encontrei nenhum microfone neste aparelho.";
  }
  if (nome === "NotReadableError") {
    return "O microfone está sendo usado por outro programa.";
  }
  return "Não consegui abrir o microfone. Pode escrever a pergunta.";
}

export function useBitzAudio(opts: { onTexto: (texto: string) => void }) {
  const { onTexto } = opts;

  const [estado, setEstado] = React.useState<EstadoDoAudio>("parado");
  const [erro, setErro] = React.useState<string | null>(null);
  const [segundos, setSegundos] = React.useState(0);

  /**
   * ⭐ O STREAM VIVO, exposto para o ESPECTRO da tela de escuta desenhar.
   *
   * Estado, e não só o ref: a tela precisa re-renderizar UMA vez, quando o
   * microfone abre, para o `<canvas>` receber o stream e começar a ler. Depois
   * disso não há mais render nenhum — o desenho roda em `requestAnimationFrame`
   * fora do React (ver `bitz-espectro.tsx`).
   *
   * ⚠️ É o MESMO stream que o `MediaRecorder` está gravando, e isso é seguro:
   * vários nós podem consumir a mesma trilha. O que não pode é o espectro
   * segurá-la depois do fim — por isso ele volta a `null` em `soltarMicrofone`,
   * junto com o `stop()` das trilhas.
   */
  const [stream, setStream] = React.useState<MediaStream | null>(null);

  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const pedacosRef = React.useRef<BlobPart[]>([]);
  const relogioRef = React.useRef<number | null>(null);
  /** Gravação abandonada pelo usuário: os bytes são jogados fora. */
  const canceladoRef = React.useRef(false);

  /**
   * Solta o microfone. Idempotente de propósito: é chamada pelo fim natural,
   * pelo cancelamento, pelo teto de duração e pela desmontagem, e não pode
   * depender de qual delas chegou primeiro.
   */
  const soltarMicrofone = React.useCallback(() => {
    if (relogioRef.current !== null) {
      window.clearInterval(relogioRef.current);
      relogioRef.current = null;
    }
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      // parar trilha já morta não é problema de ninguém.
    }
    streamRef.current = null;
    recorderRef.current = null;
    // O espectro para de desenhar assim que a trilha morre — nunca depois.
    setStream(null);
  }, []);

  // Desmontar o painel no meio de uma gravação não pode deixar o microfone
  // aberto.
  React.useEffect(() => soltarMicrofone, [soltarMicrofone]);

  const enviar = React.useCallback(
    async (blob: Blob) => {
      setEstado("enviando");
      try {
        const form = new FormData();
        form.append("audio", blob, "fala");
        const res = await fetch(`${getApiBaseUrl()}/ai/audio`, {
          method: "POST",
          body: form,
        });
        const data = await res.json().catch(() => null);

        if (!res.ok || !data?.ok) {
          // A rota devolve 200 com `{ok:false, error}` quando é estado de
          // negócio (teto de cota, sem fala). O texto já vem pronto para ler.
          setErro(
            typeof data?.error === "string"
              ? data.error
              : "Não consegui transcrever agora. Tenta de novo?",
          );
          setEstado("erro");
          return;
        }

        onTexto(String(data.texto ?? ""));
        setEstado("parado");
      } catch {
        setErro("Sem conexão para enviar o áudio. Pode escrever a pergunta.");
        setEstado("erro");
      }
    },
    [onTexto],
  );

  const parar = React.useCallback(() => {
    // `stop()` dispara `onstop`, que é onde o blob é montado.
    try {
      recorderRef.current?.stop();
    } catch {
      soltarMicrofone();
      setEstado("parado");
    }
  }, [soltarMicrofone]);

  const cancelar = React.useCallback(() => {
    canceladoRef.current = true;
    parar();
  }, [parar]);

  const gravar = React.useCallback(async () => {
    setErro(null);
    canceladoRef.current = false;
    pedacosRef.current = [];
    setSegundos(0);

    const formato = escolherFormato();
    if (!formato || typeof navigator === "undefined" || !navigator.mediaDevices) {
      setErro("Este navegador não grava áudio. Pode escrever a pergunta.");
      setEstado("erro");
      return;
    }

    setEstado("pedindo");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setErro(mensagemDoErro(err));
      setEstado("erro");
      return;
    }
    streamRef.current = stream;
    setStream(stream);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: formato });
    } catch {
      soltarMicrofone();
      setErro("Não consegui gravar neste navegador. Pode escrever a pergunta.");
      setEstado("erro");
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data?.size) pedacosRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const pedacos = pedacosRef.current;
      pedacosRef.current = [];
      // ⚠️ O microfone é solto ANTES de qualquer await do envio. Segurar a
      // trilha durante o upload deixaria a luz acesa sem estar gravando.
      soltarMicrofone();

      if (canceladoRef.current) {
        canceladoRef.current = false;
        setEstado("parado");
        return;
      }
      const blob = new Blob(pedacos, { type: formato });
      if (!blob.size) {
        setErro("Não veio áudio nenhum. Tente gravar de novo.");
        setEstado("erro");
        return;
      }
      void enviar(blob);
    };

    recorder.start();
    setEstado("gravando");

    relogioRef.current = window.setInterval(() => {
      setSegundos((s) => {
        const proximo = s + 1;
        // Teto de duração: o servidor só consegue barrar por BYTES, então o
        // corte por tempo mora aqui — e serve tanto ao custo quanto ao lojista,
        // que não fica falando para um gravador que já encheu.
        if (proximo >= MAX_SEGUNDOS) parar();
        return proximo;
      });
    }, 1000);
  }, [enviar, parar, soltarMicrofone]);

  const limparErro = React.useCallback(() => {
    setErro(null);
    setEstado("parado");
  }, []);

  return {
    estado,
    erro,
    segundos,
    /** Para o espectro da tela de escuta. `null` fora de uma gravação. */
    stream,
    maxSegundos: MAX_SEGUNDOS,
    gravar,
    parar,
    cancelar,
    limparErro,
  };
}
