import { VolumeComputer } from '../analysis/VolumeComputer';
import { CardiacMetricsComputer } from '../analysis/CardiacMetricsComputer';
import { PhaseDetector } from '../analysis/PhaseDetector';
import { WallThicknessComputer } from '../analysis/WallThicknessComputer';
import type { CardiacMetrics } from '../analysis';
import type { PhaseResult } from '../analysis/PhaseDetector';
import type { FrameMask } from '../analysis/WallThicknessComputer';

export const CVI_LABELS = [
  { id: 'lv_cavity',  name: 'LV Cavity',  color: '#E53E3E', segmentIndex: 1 },
  { id: 'myocardium', name: 'Myocardium', color: '#DD6B20', segmentIndex: 2 },
  { id: 'rv_cavity',  name: 'RV Cavity',  color: '#3182CE', segmentIndex: 3 },
] as const;

export type CviLabelId = (typeof CVI_LABELS)[number]['id'];

interface FrameData {
  lvAreaMm2: number;
  rvAreaMm2: number;
  lvMask: Uint8Array | null;
  myoMask: Uint8Array | null;
  width: number;
  height: number;
}

export interface CviLabsState {
  frameData: Map<number, FrameData>;
  pixelSpacingMm: number;
  sliceSpacingMm: number;
  sliceCount: number;
  referenceRoi: any | null;
   labelVisibility: Record<CviLabelId, boolean>;
  volumeSeriesLV: number[];
  volumeSeriesRV: number[];
  metrics: CardiacMetrics;
  phase: PhaseResult;
  wallThicknessMm: (number | null)[];
}

type Subscriber = (state: CviLabsState) => void;
const subscribers = new Set<Subscriber>();

const NULL_METRICS: CardiacMetrics = {
  ef: null, edvMl: null, esvMl: null, strokeVolumeMl: null, wallThicknessMm: null,
};

let _state: CviLabsState = {
  frameData: new Map(),
  pixelSpacingMm: 1,
  sliceSpacingMm: 8,
  sliceCount: 1,
  referenceRoi: null,
   labelVisibility: {
     lv_cavity: true,
     myocardium: true,
     rv_cavity: true,
   },
  volumeSeriesLV: [],
  volumeSeriesRV: [],
  metrics: NULL_METRICS,
  phase: { edFrame: -1, esFrame: -1 },
  wallThicknessMm: [],
};

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

const notify = () => subscribers.forEach(s => s(_state));

const _recompute = () => {
  const entries = Array.from(_state.frameData.entries());

  const lvSlice = entries.map(([fi, fd]) => ({ frameIndex: fi, areaMm2: fd.lvAreaMm2 }));
  const rvSlice = entries.map(([fi, fd]) => ({ frameIndex: fi, areaMm2: fd.rvAreaMm2 }));

  const lvSeries = VolumeComputer.computeVolumeSeries([lvSlice], _state.sliceSpacingMm);
  const rvSeries = VolumeComputer.computeVolumeSeries([rvSlice], _state.sliceSpacingMm);
  const metrics = CardiacMetricsComputer.compute(lvSeries);
  const phase = PhaseDetector.detect(lvSeries);

  const lvMasks: FrameMask[] = entries
    .filter(([, fd]) => fd.lvMask !== null)
    .map(([fi, fd]) => ({ frameIndex: fi, data: fd.lvMask!, width: fd.width, height: fd.height }));
  const myoMasks: FrameMask[] = entries
    .filter(([, fd]) => fd.myoMask !== null)
    .map(([fi, fd]) => ({ frameIndex: fi, data: fd.myoMask!, width: fd.width, height: fd.height }));
  const wallThicknessMm = WallThicknessComputer.computeThicknessSeries(
    lvMasks, myoMasks, _state.pixelSpacingMm
  );

  _state = { ..._state, volumeSeriesLV: lvSeries, volumeSeriesRV: rvSeries, metrics, phase, wallThicknessMm };
  notify();
};

const scheduleRecompute = () => {
  if (_debounceTimer !== null) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(_recompute, 200);
};

export const getCviLabsState = () => _state;

export const subscribeCviLabs = (fn: Subscriber): (() => void) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};

export const setSpacing = (pixelSpacingMm: number, sliceSpacingMm: number, sliceCount: number) => {
  _state = { ..._state, pixelSpacingMm, sliceSpacingMm, sliceCount };
};

export const setReferenceRoi = (roi: any) => {
  _state = { ..._state, referenceRoi: roi };
  notify();
};

export const updateFrameData = (
  frameIndex: number,
  scalarData: Uint8Array,
  width: number,
  height: number,
  pixelSpacingMm: number
) => {
  const sp2 = pixelSpacingMm * pixelSpacingMm;
  let lvCount = 0, myoCount = 0, rvCount = 0;
  const lvMask = new Uint8Array(scalarData.length);
  const myoMask = new Uint8Array(scalarData.length);

  for (let i = 0; i < scalarData.length; i++) {
    const v = scalarData[i];
    if (v === 1) { lvCount++; lvMask[i] = 1; }
    else if (v === 2) { myoCount++; myoMask[i] = 1; }
    else if (v === 3) { rvCount++; }
  }

  _state.frameData.set(frameIndex, {
    lvAreaMm2: lvCount * sp2,
    rvAreaMm2: rvCount * sp2,
    lvMask: lvCount > 0 ? lvMask : null,
    myoMask: myoCount > 0 ? myoMask : null,
    width,
    height,
  });
  _state = { ..._state, pixelSpacingMm };
  scheduleRecompute();
};

export const resetCviLabsState = () => {
  if (_debounceTimer !== null) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  _state = {
    frameData: new Map(),
    pixelSpacingMm: 1, sliceSpacingMm: 8, sliceCount: 1,
    referenceRoi: null,
    labelVisibility: {
      lv_cavity: true,
      myocardium: true,
      rv_cavity: true,
    },
    volumeSeriesLV: [], volumeSeriesRV: [],
    metrics: NULL_METRICS, phase: { edFrame: -1, esFrame: -1 }, wallThicknessMm: [],
  };
  notify();
};

export const setCviLabelVisibility = (labelId: CviLabelId, visible: boolean) => {
  _state = {
    ..._state,
    labelVisibility: {
      ..._state.labelVisibility,
      [labelId]: visible,
    },
  };
  notify();
};
