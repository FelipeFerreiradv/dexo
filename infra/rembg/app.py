"""
Dexo rembg sidecar.

Endpoints HTTP minimos pra remocao de fundo via U2Net (rembg). Servico
proposital: nao tem auth, nao expoe nada alem do necessario, depende de
sticky session pra reaproveitar o modelo em memoria.

POST /remove-bg  multipart 'file' image/*  -> image/png transparente
GET  /health     liveness
"""

from io import BytesIO

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from rembg import new_session, remove

# Limites de tamanho:
# - 10 MB de input cobre folgadamente o limite do app (5 MB) e ainda
#   protege o sidecar de payloads patologicos.
MAX_BYTES = 10 * 1024 * 1024
MODEL_NAME = "u2net"

app = FastAPI(title="Dexo rembg sidecar", version="1.0.0")

_session = None


def _get_session():
    """Lazy-init da sessao do rembg (carrega o ONNX uma unica vez)."""
    global _session
    if _session is None:
        _session = new_session(MODEL_NAME)
    return _session


@app.on_event("startup")
def warmup():
    """Pre-carrega o modelo no boot pra que o primeiro request nao espere."""
    _get_session()


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/remove-bg")
async def remove_bg(file: UploadFile = File(...)):
    # Aceita image/* e application/octet-stream (fallback comum quando o
    # cliente nao seta MIME). Outros tipos viram log + 400 com motivo
    # explicito pra facilitar diagnostico do lado do caller.
    ctype = (file.content_type or "").lower()
    if not (ctype.startswith("image/") or ctype == "application/octet-stream"):
        raise HTTPException(
            status_code=400,
            detail=f"unsupported content_type: {file.content_type!r}",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="payload too large")

    try:
        out = remove(raw, session=_get_session())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"rembg failed: {exc}") from exc

    # rembg pode devolver bytes diretamente ou PIL.Image dependendo da
    # versao; normalizamos pra bytes PNG.
    if isinstance(out, (bytes, bytearray)):
        png_bytes = bytes(out)
    else:
        buf = BytesIO()
        out.save(buf, format="PNG")
        png_bytes = buf.getvalue()

    return Response(content=png_bytes, media_type="image/png")
