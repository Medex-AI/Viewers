import { isTouchCapableDevice } from './brushCursorDom';

let activeViewportHintTargets: HTMLElement[] = [];

export const removeManualContourHints = (): void => {
  activeViewportHintTargets.forEach(target => {
    const hint = target.querySelector('.ovi-manual-contour-hint');
    if (hint) {
      hint.remove();
    }
  });
  activeViewportHintTargets = [];
};

export const renderManualContourHints = (): void => {
  removeManualContourHints();
  if (typeof document === 'undefined' || isTouchCapableDevice()) {
    return;
  }

  const viewports = Array.from(document.querySelectorAll('[data-viewport-uid]'));
  activeViewportHintTargets = viewports.filter(node => node instanceof HTMLElement) as HTMLElement[];

  activeViewportHintTargets.forEach(target => {
    const hint = document.createElement('div');
    hint.className = 'ovi-manual-contour-hint';
    const lineOne = document.createElement('div');
    lineOne.textContent = 'Right-click: add/remove point';
    const lineTwo = document.createElement('div');
    lineTwo.textContent = 'Cmd/Ctrl+V: paste previous contour';
    hint.append(lineOne, lineTwo);
    target.appendChild(hint);
  });
};
