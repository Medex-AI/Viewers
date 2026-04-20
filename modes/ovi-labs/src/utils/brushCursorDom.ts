import { getEnabledElement } from '@cornerstonejs/core';

// Module-owned state
let brushCursorOverlay: HTMLDivElement | null = null;
let gestureHudOverlay: HTMLDivElement | null = null;
let currentCanvasPxPerMm: number | null = null;
let currentBrushPointerType: string | null = null;

export const setBrushPointerType = (type: string | null): void => {
  currentBrushPointerType = type;
};

export const getCanvasPxPerMm = (): number | null => currentCanvasPxPerMm;

export const computeCanvasPxPerMm = (element: HTMLElement): number | null => {
  try {
    const enabledEl = getEnabledElement(element as any);
    const camera = (enabledEl?.viewport as any)?.getCamera?.();
    if (!camera?.parallelScale || !element.clientHeight) {
      return null;
    }
    return element.clientHeight / (camera.parallelScale * 2);
  } catch {
    return null;
  }
};

export const isTouchCapableDevice = () =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export const shouldUseNativeBrushCursor = () => {
  // Temporary demo workaround:
  // on tablet + stylus we force the non-native OVI brush cursor path because
  // the native Cornerstone brush cursor does not currently behave correctly.
  // The proper fix should map stylus behavior to the same hover/cursor lifecycle
  // as desktop pointer hover instead of branching cursor implementations here.
  return !(isTouchCapableDevice() && currentBrushPointerType === 'pen');
};

export const ensureBrushCursorOverlay = (): HTMLDivElement | null => {
  if (shouldUseNativeBrushCursor()) {
    return null;
  }

  if (typeof document === 'undefined') {
    return null;
  }

  if (!brushCursorOverlay) {
    brushCursorOverlay = document.createElement('div');
    brushCursorOverlay.className = 'ovi-brush-cursor-overlay';
    brushCursorOverlay.style.position = 'fixed';
    brushCursorOverlay.style.pointerEvents = 'none';
    brushCursorOverlay.style.borderRadius = '9999px';
    brushCursorOverlay.style.borderStyle = 'solid';
    brushCursorOverlay.style.borderWidth = '2px';
    brushCursorOverlay.style.boxSizing = 'border-box';
    brushCursorOverlay.style.transform = 'translate(-50%, -50%)';
    brushCursorOverlay.style.outline = 'none';
    brushCursorOverlay.style.boxShadow = 'none';
    brushCursorOverlay.style.background = 'transparent';
    brushCursorOverlay.style.zIndex = '2147483647';
    brushCursorOverlay.style.display = 'none';
    document.body.appendChild(brushCursorOverlay);
  }

  return brushCursorOverlay;
};

export const hideBrushCursorOverlay = (): void => {
  if (shouldUseNativeBrushCursor()) {
    return;
  }

  if (brushCursorOverlay) {
    brushCursorOverlay.style.display = 'none';
  }
};

export const ensureGestureHudOverlay = (): HTMLDivElement | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  if (!gestureHudOverlay) {
    gestureHudOverlay = document.createElement('div');
    gestureHudOverlay.className = 'ovi-pencil-gesture-hud';
    gestureHudOverlay.style.position = 'fixed';
    gestureHudOverlay.style.top = '20px';
    gestureHudOverlay.style.left = '50%';
    gestureHudOverlay.style.transform = 'translateX(-50%)';
    gestureHudOverlay.style.padding = '8px 12px';
    gestureHudOverlay.style.borderRadius = '9999px';
    gestureHudOverlay.style.background = 'rgba(15, 23, 42, 0.9)';
    gestureHudOverlay.style.color = '#F8FAFC';
    gestureHudOverlay.style.fontSize = '12px';
    gestureHudOverlay.style.fontWeight = '600';
    gestureHudOverlay.style.pointerEvents = 'none';
    gestureHudOverlay.style.zIndex = '2147483647';
    gestureHudOverlay.style.display = 'none';
    document.body.appendChild(gestureHudOverlay);
  }

  return gestureHudOverlay;
};

export const showGestureHud = (message: string): void => {
  const hud = ensureGestureHudOverlay();
  if (!hud) {
    return;
  }

  hud.textContent = message;
  hud.style.display = 'block';
  window.setTimeout(() => {
    if (hud.textContent === message) {
      hud.style.display = 'none';
    }
  }, 1200);
};

export const restoreViewportCursor = (): void => {
  if (typeof document === 'undefined') {
    return;
  }

  document.querySelectorAll('[data-viewport-uid]').forEach(viewport => {
    if (viewport instanceof HTMLElement) {
      viewport.style.removeProperty('cursor');
    }
  });
};

export const getViewportElementAtPoint = (clientX: number, clientY: number): HTMLElement | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const el = document.elementFromPoint(clientX, clientY);
  if (!el) {
    return null;
  }

  const viewport = el.closest('[data-viewport-uid]');
  return viewport instanceof HTMLElement ? viewport : null;
};

/**
 * Sync the brush cursor overlay position and size.
 * @param labelColor - current active label hex color
 * @param brushSizeMm - current brush radius in mm
 */
export const syncBrushCursorOverlay = (
  element: HTMLElement | undefined,
  canvasPoint: { x?: number; y?: number } | number[] | undefined,
  labelColor: string,
  brushSizeMm: number
): void => {
  if (shouldUseNativeBrushCursor()) {
    hideBrushCursorOverlay();
    return;
  }

  const overlay = ensureBrushCursorOverlay();
  if (!overlay || !element || !canvasPoint) {
    hideBrushCursorOverlay();
    return;
  }

  const x = Array.isArray(canvasPoint) ? canvasPoint[0] : canvasPoint.x;
  const y = Array.isArray(canvasPoint) ? canvasPoint[1] : canvasPoint.y;
  if (typeof x !== 'number' || typeof y !== 'number') {
    hideBrushCursorOverlay();
    return;
  }

  if (x < 0 || y < 0 || x > element.clientWidth || y > element.clientHeight) {
    hideBrushCursorOverlay();
    return;
  }

  const pxPerMm = computeCanvasPxPerMm(element) ?? currentCanvasPxPerMm ?? 1;
  currentCanvasPxPerMm = pxPerMm;

  const rect = element.getBoundingClientRect();
  const diameter = Math.max(8, brushSizeMm * 2 * pxPerMm);

  overlay.style.display = 'block';
  overlay.style.left = `${rect.left + x}px`;
  overlay.style.top = `${rect.top + y}px`;
  overlay.style.width = `${diameter}px`;
  overlay.style.height = `${diameter}px`;
  overlay.style.borderColor = labelColor;
  overlay.style.backgroundColor = 'transparent';
};

/**
 * Sync the brush cursor overlay to a client-coordinate position.
 * @param labelColor - current active label hex color
 * @param brushSizeMm - current brush radius in mm
 */
export const syncBrushCursorOverlayAtClient = (
  clientX: number,
  clientY: number,
  labelColor: string,
  brushSizeMm: number
): void => {
  if (shouldUseNativeBrushCursor()) {
    hideBrushCursorOverlay();
    return;
  }

  const overlay = ensureBrushCursorOverlay();
  if (!overlay) {
    return;
  }

  const viewportEl = getViewportElementAtPoint(clientX, clientY);
  if (!viewportEl) {
    hideBrushCursorOverlay();
    return;
  }

  const pxPerMm = computeCanvasPxPerMm(viewportEl) ?? currentCanvasPxPerMm ?? 1;
  currentCanvasPxPerMm = pxPerMm;

  const diameter = Math.max(8, brushSizeMm * 2 * pxPerMm);

  overlay.style.display = 'block';
  overlay.style.left = `${clientX}px`;
  overlay.style.top = `${clientY}px`;
  overlay.style.width = `${diameter}px`;
  overlay.style.height = `${diameter}px`;
  overlay.style.borderColor = labelColor;
  overlay.style.backgroundColor = 'transparent';
};

/** Directly update just the brush cursor color without repositioning. */
export const updateBrushCursorColor = (
  labelColor: string,
  isEraser: boolean
): void => {
  if (!brushCursorOverlay || brushCursorOverlay.style.display === 'none') {
    return;
  }
  brushCursorOverlay.style.borderColor = labelColor;
  brushCursorOverlay.style.backgroundColor = isEraser ? 'transparent' : `${labelColor}26`;
};

/**
 * Update the cached canvas px/mm scale. Returns the new scale if it changed,
 * or null if unchanged (allows the caller to decide whether to dispatch an event).
 */
export const updateCurrentCanvasScale = (element: HTMLElement): number | null => {
  const newScale = computeCanvasPxPerMm(element);
  if (newScale !== null && newScale !== currentCanvasPxPerMm) {
    currentCanvasPxPerMm = newScale;
    return newScale;
  }
  return null;
};

/** Tear down all brush cursor DOM state (call during mode cleanup). */
export const resetBrushCursorState = (): void => {
  currentCanvasPxPerMm = null;
  currentBrushPointerType = null;
  if (brushCursorOverlay) {
    brushCursorOverlay.style.display = 'none';
    brushCursorOverlay.remove();
    brushCursorOverlay = null;
  }
  if (gestureHudOverlay) {
    gestureHudOverlay.remove();
    gestureHudOverlay = null;
  }
};
