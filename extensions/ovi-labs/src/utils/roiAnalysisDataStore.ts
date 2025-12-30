export type RoiAnalysisData = {
  annotationUID: string;
  roiRevision: number;
  imageIds: string[];
  width: number;
  height: number;
  step: number;
  frames: Float32Array[];
  spacing: { row: number | null; column: number | null };
  createdAt: number;
};

type RoiAnalysisListener = (data: RoiAnalysisData | null) => void;

let currentData: RoiAnalysisData | null = null;
const listeners = new Set<RoiAnalysisListener>();

export const getRoiAnalysisData = () => currentData;

export const setRoiAnalysisData = (data: RoiAnalysisData | null) => {
  currentData = data;
  listeners.forEach(listener => listener(currentData));
};

export const subscribeRoiAnalysisData = (listener: RoiAnalysisListener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
