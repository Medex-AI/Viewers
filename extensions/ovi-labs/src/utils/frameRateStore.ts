type FrameRateListener = (value: number) => void;
type FrameRateSource = 'manual' | 'metadata' | 'default';

let currentFrameRate = 1;
let frameRateSource: FrameRateSource = 'default';
const listeners = new Set<FrameRateListener>();

export const getFrameRate = () => currentFrameRate;

export const getFrameRateSource = () => frameRateSource;

export const setFrameRate = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  currentFrameRate = value;
  frameRateSource = 'manual';
  listeners.forEach(listener => listener(currentFrameRate));
};

export const setFrameRateFromMetadata = (
  value: number,
  source: FrameRateSource = 'metadata',
  options: { force?: boolean } = {}
) => {
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  if (!options.force && frameRateSource === 'manual') {
    return;
  }
  currentFrameRate = value;
  frameRateSource = source;
  listeners.forEach(listener => listener(currentFrameRate));
};

export const subscribeFrameRate = (listener: FrameRateListener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
