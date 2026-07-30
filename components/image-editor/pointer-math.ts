/**
 * Matemática de gestos do editor (PR 6) — puro, sem DOM/fabric.
 *
 * fabric v6+ REMOVEU o suporte a gestures (pinch/rotate) do core; o uso real
 * do Dexo é celular no pátio, então pinch-zoom e pan de dois dedos são
 * implementados à mão com Pointer Events (`touch-action:none` no wrapper).
 * Este módulo só faz as contas; o hook aplica no viewport do fabric.
 */

export interface PointerPoint {
  id: number;
  x: number;
  y: number;
}

export function distance(a: PointerPoint, b: PointerPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: PointerPoint, b: PointerPoint): {
  x: number;
  y: number;
} {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export interface PinchState {
  startDistance: number;
  startZoom: number;
  /** Ponto fixo do zoom (midpoint inicial), em coordenadas do canvas HTML. */
  originX: number;
  originY: number;
}

export function beginPinch(
  a: PointerPoint,
  b: PointerPoint,
  currentZoom: number,
): PinchState {
  const mid = midpoint(a, b);
  return {
    startDistance: Math.max(1, distance(a, b)),
    startZoom: currentZoom,
    originX: mid.x,
    originY: mid.y,
  };
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 8;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zoom novo dado o afastamento atual dos dedos. */
export function pinchZoom(state: PinchState, a: PointerPoint, b: PointerPoint): number {
  return clampZoom((distance(a, b) / state.startDistance) * state.startZoom);
}

/** Passo de zoom de roda de mouse (delta negativo = aproxima). */
export function wheelZoom(currentZoom: number, deltaY: number): number {
  const factor = Math.exp(-deltaY / 400);
  return clampZoom(currentZoom * factor);
}
