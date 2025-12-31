type KymographSettings = {
  spatialAxis: 'major' | 'minor';
  colormap: string;
  showProfileLine: boolean;
};

let currentSettings: KymographSettings = {
  spatialAxis: 'major',
  colormap: 'grayscale',
  showProfileLine: true,
};

type Subscriber = (settings: KymographSettings) => void;
const subscribers: Set<Subscriber> = new Set();

export const getKymographSettings = (): KymographSettings => currentSettings;

export const setKymographSettings = (settings: Partial<KymographSettings>): void => {
  currentSettings = { ...currentSettings, ...settings };
  subscribers.forEach(subscriber => subscriber(currentSettings));
};

export const subscribeKymographSettings = (subscriber: Subscriber): (() => void) => {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
};
