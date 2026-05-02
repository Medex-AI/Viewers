export interface CardiacMetrics {
  ef: number | null;
  strokeVolumeMl: number | null;
  edvMl: number | null;
  esvMl: number | null;
  wallThicknessMm: number | null;
}

export { VolumeComputer } from './VolumeComputer';
export type { SliceMask, SliceMasks } from './VolumeComputer';
export { CardiacMetricsComputer } from './CardiacMetricsComputer';
export { PhaseDetector } from './PhaseDetector';
export type { PhaseResult } from './PhaseDetector';
export { WallThicknessComputer } from './WallThicknessComputer';
export type { FrameMask } from './WallThicknessComputer';
export { COComputer } from './COComputer';
export type { HRResult, HRSource } from './COComputer';
