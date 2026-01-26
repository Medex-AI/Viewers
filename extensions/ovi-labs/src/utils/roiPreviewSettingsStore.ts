type RoiPreviewInterpolation = 'bilinear' | 'nearest' | 'trilinear';

type RoiPreviewSettings = {
  accuratePreviewDelayMs: number;
  accurateInterpolation: RoiPreviewInterpolation;
};

const DEFAULT_SETTINGS: RoiPreviewSettings = {
  accuratePreviewDelayMs: 200,
  accurateInterpolation: 'bilinear',
};

const STORAGE_KEY = 'medex.roiPreviewSettings';

const loadSettings = (): RoiPreviewSettings => {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<RoiPreviewSettings>;
    return {
      accuratePreviewDelayMs:
        typeof parsed.accuratePreviewDelayMs === 'number'
          ? parsed.accuratePreviewDelayMs
          : DEFAULT_SETTINGS.accuratePreviewDelayMs,
      accurateInterpolation:
        parsed.accurateInterpolation === 'nearest' ||
        parsed.accurateInterpolation === 'bilinear' ||
        parsed.accurateInterpolation === 'trilinear'
          ? parsed.accurateInterpolation
          : DEFAULT_SETTINGS.accurateInterpolation,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

let currentSettings: RoiPreviewSettings = loadSettings();

type Subscriber = (settings: RoiPreviewSettings) => void;
const subscribers: Set<Subscriber> = new Set();

export const getRoiPreviewSettings = (): RoiPreviewSettings => currentSettings;

export const getDefaultRoiPreviewSettings = (): RoiPreviewSettings => ({
  ...DEFAULT_SETTINGS,
});

export const setRoiPreviewSettings = (settings: Partial<RoiPreviewSettings>): void => {
  currentSettings = { ...currentSettings, ...settings };

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings));
    } catch {
      // Ignore persistence failures (e.g., storage unavailable)
    }
  }

  subscribers.forEach(subscriber => subscriber(currentSettings));
};

export const subscribeRoiPreviewSettings = (subscriber: Subscriber): (() => void) => {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
};
