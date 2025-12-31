type FrameRateListener = (value: number) => void;

let currentFrameRate = 1;
const listeners = new Set<FrameRateListener>();

export const getFrameRate = () => currentFrameRate;

export const setFrameRate = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  currentFrameRate = value;
  listeners.forEach(listener => listener(currentFrameRate));
};

export const subscribeFrameRate = (listener: FrameRateListener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
