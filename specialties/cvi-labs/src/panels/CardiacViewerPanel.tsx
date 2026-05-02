import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  cache,
  eventTarget,
  metaData,
} from '@cornerstonejs/core';
import { annotation, Enums as toolEnums } from '@cornerstonejs/tools';
import { useViewportGrid } from '@ohif/ui-next';
import {
  getCviLabsState,
  subscribeCviLabs,
  setSpacing,
  setReferenceRoi,
   setCviLabelVisibility,
  updateFrameData,
  resetCviLabsState,
  CVI_LABELS,
  type CviLabsState,
} from '../stores/cviLabsSegmentationStore';
import { COComputer } from '../analysis/COComputer';
import VolumeTimeCurveChart from './VolumeTimeCurveChart';
import WallThicknessChart from './WallThicknessChart';

interface CardiacViewerPanelProps {
  commandsManager?: any;
  servicesManager?: any;
}

const ROI_TOOL_NAME = 'RotatableRectangleROI';
const MEDEX_ORANGE = '#F47620';

const METRIC_FULL_NAMES: Record<string, string> = {
  EF: 'Ejection Fraction',
  EDV: 'End-Diastolic Volume',
  ESV: 'End-Systolic Volume',
  SV: 'Stroke Volume',
};

const MetricValue: React.FC<{ label: string; value: string; testId: string }> = ({ label, value, testId }) => (
  <div
    className="flex flex-col items-center rounded border border-gray-700 bg-gray-900 p-2"
    title={METRIC_FULL_NAMES[label] ?? label}
  >
    <span className="text-xs text-gray-400">{label}</span>
    <span className="text-sm font-semibold text-white" data-testid={testId} data-cy={testId}>{value}</span>
  </div>
);

const CardiacViewerPanel: React.FC<CardiacViewerPanelProps> = ({ commandsManager, servicesManager }) => {
  const [{ activeViewportId }] = useViewportGrid();
  const [cviState, setCviState] = useState<CviLabsState>(getCviLabsState());
  const [roiAnnotation, setRoiAnnotation] = useState<any>(null);
  const [roiPreviewUrl, setRoiPreviewUrl] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [hrOverride, setHrOverride] = useState<string>('');
  const [hrFromDicom, setHrFromDicom] = useState<{ bpm: number | null; source: string | null }>({ bpm: null, source: null });
  const [singleSliceWarning, setSingleSliceWarning] = useState(false);
  const [activeTab, setActiveTab] = useState<'metrics' | 'vtc' | 'wallthickness'>('metrics');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const debounceSegRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
  const displaySetService = servicesManager?.services?.displaySetService;

  // ── helpers ────────────────────────────────────────────────────────────────

  const getViewport = useCallback(() => {
    if (!activeViewportId || !cornerstoneViewportService) return null;
    return cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
  }, [activeViewportId, cornerstoneViewportService]);

  const getImageIds = useCallback(() => {
    const vp = getViewport();
    return vp?.getImageIds?.() ?? [];
  }, [getViewport]);

  const getCurrentImageId = useCallback(() => {
    const vp = getViewport();
    return vp?.getCurrentImageId?.() ?? getImageIds()[0] ?? null;
  }, [getViewport, getImageIds]);

  const getCurrentFrameIndex = useCallback(() => {
    const vp = getViewport() as any;
    return vp?.getCurrentImageIdIndex?.() ?? vp?.getFrameIndex?.() ?? 0;
  }, [getViewport]);

  const jumpToFrame = useCallback((frameIndex: number) => {
    const vp = getViewport() as any;
    if (!vp) return;
    if (vp.setImageIdIndex) {
      vp.setImageIdIndex(frameIndex);
    } else if (vp.setFrameIndex) {
      vp.setFrameIndex(frameIndex);
    }
  }, [getViewport]);

  // ── DICOM HR extraction ────────────────────────────────────────────────────

  const extractHRFromDicom = useCallback(() => {
    const imageId = getCurrentImageId();
    if (!imageId) return;
    const result = COComputer.extractHR(imageId);
    setHrFromDicom({ bpm: result.heartRateBpm, source: result.source });
  }, [getCurrentImageId]);

  // ── spacing from DICOM ─────────────────────────────────────────────────────

  const readSpacing = useCallback(() => {
    const imageId = getCurrentImageId();
    if (!imageId) return;
    const imagePlane = metaData.get('imagePlaneModule', imageId) ?? {};
    const instance = metaData.get('instance', imageId) ?? {};
    const colSpacing: number = imagePlane.columnPixelSpacing ?? imagePlane.rowPixelSpacing ?? 1;
    const sliceSpacing: number =
      Number(instance.x00180088 ?? instance.SpacingBetweenSlices) ||
      Number(instance.x00180050 ?? instance.SliceThickness) ||
      8;
    const imageIds = getImageIds();
    setSingleSliceWarning(imageIds.length <= 1);
    setSpacing(colSpacing, sliceSpacing, 1);
  }, [getCurrentImageId, getImageIds]);

  // ── labelmap ingestion ─────────────────────────────────────────────────────

  const ingestLabelmapFrames = useCallback(async () => {
    if (!servicesManager) return;
    const { segmentationService } = servicesManager.services ?? {};
    if (!segmentationService) return;

    const activeSegmentation = segmentationService.getActiveSegmentation?.(activeViewportId);
    if (!activeSegmentation) return;

    const labelmapData = activeSegmentation.representationData?.[
      toolEnums.SegmentationRepresentations.Labelmap
    ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;
    const imageIds: string[] = labelmapData?.imageIds ?? [];
    if (!imageIds.length) return;

    const imageId0 = getCurrentImageId();
    const imagePlane = imageId0 ? (metaData.get('imagePlaneModule', imageId0) ?? {}) : {};
    const pixelSpacingMm: number = imagePlane.columnPixelSpacing ?? imagePlane.rowPixelSpacing ?? 1;

    for (let fi = 0; fi < imageIds.length; fi++) {
      try {
        const img =
          cache.getImage(imageIds[fi]) ??
          (await (window as any).imageLoader?.loadAndCacheImage?.(imageIds[fi]));
        const scalarData: Uint8Array | undefined =
          img?.voxelManager?.getScalarData?.() ?? img?.getPixelData?.();
        const w: number = img?.columns ?? img?.width ?? 0;
        const h: number = img?.rows ?? img?.height ?? 0;
        if (!scalarData || !w || !h) continue;
        updateFrameData(fi, scalarData as Uint8Array, w, h, pixelSpacingMm);
      } catch {
        // frame not in cache yet — will be picked up on next event
      }
    }
  }, [activeViewportId, servicesManager, getCurrentImageId]);

  const scheduleIngest = useCallback(() => {
    if (debounceSegRef.current) clearTimeout(debounceSegRef.current);
    debounceSegRef.current = setTimeout(ingestLabelmapFrames, 200);
  }, [ingestLabelmapFrames]);

  const toggleLabelVisibility = useCallback((labelId: string) => {
    const cviLabelId = labelId as (typeof CVI_LABELS)[number]['id'];
    const newVisible = !(cviState.labelVisibility?.[cviLabelId] ?? true);
    setCviLabelVisibility(cviLabelId, newVisible);

    const label = CVI_LABELS.find(l => l.id === labelId);
    if (label && servicesManager && activeViewportId) {
      const segSvc = servicesManager.services?.segmentationService;
      const activeSeg = segSvc?.getActiveSegmentation?.(activeViewportId);
      const segId = activeSeg?.segmentationId || activeSeg?.id;
      if (segSvc && segId) {
        segSvc.setSegmentVisibility?.(activeViewportId, segId, label.segmentIndex, newVisible);
      }
    }
  }, [cviState.labelVisibility, servicesManager, activeViewportId]);

  // ── ROI preview canvas ─────────────────────────────────────────────────────

  const renderPreview = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !roiAnnotation) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const vp = getViewport() as any;
    if (!vp) return;
    const imageId = vp.getCurrentImageId?.();
    if (!imageId) return;
    const image = cache.getImage(imageId);
    if (!image) return;

    const pixelData = image.getPixelData?.() ?? image?.voxelManager?.getScalarData?.();
    const cols: number = image.columns ?? image.width ?? 0;
    const rows: number = image.rows ?? image.height ?? 0;
    if (!pixelData || !cols || !rows) return;

    const points = roiAnnotation?.data?.handles?.points?.slice(0, 4) ?? [];
    if (points.length < 4) return;

    const worldToIndex = (p: number[]) => {
      if (vp.worldToIndex) return vp.worldToIndex(p) as number[];
      const ip = metaData.get('imagePlaneModule', imageId) ?? {};
      const orientation = ip.imageOrientationPatient ?? [1,0,0,0,1,0];
      const position = ip.imagePositionPatient ?? [0,0,0];
      const rsp = ip.rowPixelSpacing ?? 1, csp = ip.columnPixelSpacing ?? 1;
      const rc = [orientation[0], orientation[1], orientation[2]];
      const cc = [orientation[3], orientation[4], orientation[5]];
      const dx = p[0]-position[0], dy = p[1]-position[1], dz = p[2]-position[2];
      return [
        (dx*rc[0]+dy*rc[1]+dz*rc[2])/csp,
        (dx*cc[0]+dy*cc[1]+dz*cc[2])/rsp,
        0,
      ];
    };

    const idx = points.map((p: number[]) => worldToIndex(p));
    const [bl, br, tl] = idx;
    const wVec = [br[0]-bl[0], br[1]-bl[1]];
    const hVec = [tl[0]-bl[0], tl[1]-bl[1]];
    const wLen = Math.hypot(wVec[0], wVec[1]) || 1;
    const hLen = Math.hypot(hVec[0], hVec[1]) || 1;
    const outW = Math.max(1, Math.round(wLen));
    const outH = Math.max(1, Math.round(hLen));
    const uwx = wVec[0]/wLen, uwy = wVec[1]/wLen;
    const uhx = hVec[0]/hLen, uhy = hVec[1]/hLen;

    // find display range
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < pixelData.length; i++) {
      const v = pixelData[i];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const range = maxV - minV || 1;

    canvas.width = outW;
    canvas.height = outH;
    const imgData = ctx.createImageData(outW, outH);
    for (let ry = 0; ry < outH; ry++) {
      for (let rx = 0; rx < outW; rx++) {
        const sx = bl[0] + uwx*rx + uhx*ry;
        const sy = bl[1] + uwy*rx + uhy*ry;
        const col = Math.min(cols-1, Math.max(0, Math.round(sx)));
        const row = Math.min(rows-1, Math.max(0, Math.round(sy)));
        const raw = pixelData[row*cols+col];
        const gray = Math.round(((raw-minV)/range)*255);
        const i4 = (ry*outW+rx)*4;
        imgData.data[i4] = gray; imgData.data[i4+1] = gray;
        imgData.data[i4+2] = gray; imgData.data[i4+3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    setRoiPreviewUrl(canvas.toDataURL());
  }, [roiAnnotation, getViewport]);

  // ── subscriptions ──────────────────────────────────────────────────────────

  useEffect(() => {
    return subscribeCviLabs(setCviState);
  }, []);

  // ROI annotation tracking
  useEffect(() => {
    const findRoi = () => {
      const manager = annotation.state.getAnnotationManager();
      const frames = manager.getFramesOfReference() ?? [];
      for (const frame of frames) {
        const anns = manager.getAnnotations(frame, ROI_TOOL_NAME) ?? [];
        if (anns.length) {
          const roi = anns[anns.length - 1];
          setRoiAnnotation(roi);
          setReferenceRoi(roi);
          return;
        }
      }
    };
    findRoi();
    const onAnnotation = () => findRoi();
    eventTarget.addEventListener(toolEnums.Events.ANNOTATION_ADDED, onAnnotation);
    eventTarget.addEventListener(toolEnums.Events.ANNOTATION_MODIFIED, onAnnotation);
    return () => {
      eventTarget.removeEventListener(toolEnums.Events.ANNOTATION_ADDED, onAnnotation);
      eventTarget.removeEventListener(toolEnums.Events.ANNOTATION_MODIFIED, onAnnotation);
    };
  }, []);

  // Segmentation change → ingest (via segmentationService.subscribe, same pattern as SegmentationExportControls)
  useEffect(() => {
    const segmentationService = servicesManager?.services?.segmentationService;
    if (!segmentationService) {
      scheduleIngest();
      return;
    }
    const subscriptions: Array<{ unsubscribe: () => void }> = [];
    const onModified = () => scheduleIngest();
    for (const evt of [
      segmentationService.EVENTS?.SEGMENTATION_DATA_MODIFIED,
      segmentationService.EVENTS?.SEGMENTATION_ADDED,
    ]) {
      if (evt) subscriptions.push(segmentationService.subscribe(evt, onModified));
    }
    scheduleIngest();
    return () => subscriptions.forEach(s => s.unsubscribe());
  }, [servicesManager, scheduleIngest]);

  // Frame scroll
  useEffect(() => {
    const onImageRendered = () => {
      const fi = getCurrentFrameIndex();
      setCurrentFrame(fi);
      renderPreview();
    };
    const { STACK_NEW_IMAGE, IMAGE_RENDERED } = (window as any).cornerstoneEnums ?? {};
    if (IMAGE_RENDERED) {
      eventTarget.addEventListener(IMAGE_RENDERED, onImageRendered);
    }
    return () => {
      if (IMAGE_RENDERED) {
        eventTarget.removeEventListener(IMAGE_RENDERED, onImageRendered);
      }
    };
  }, [getCurrentFrameIndex, renderPreview]);

  // Re-render preview when roi or frame changes
  useEffect(() => {
    renderPreview();
  }, [roiAnnotation, currentFrame, renderPreview]);

  // Extract DICOM spacing + HR on viewport change
  useEffect(() => {
    readSpacing();
    extractHRFromDicom();
    resetCviLabsState();
    scheduleIngest();
  }, [activeViewportId]);

  // ── derived display values ─────────────────────────────────────────────────

  const { metrics, phase, volumeSeriesLV, volumeSeriesRV, wallThicknessMm } = cviState;

  const fmt = (v: number | null, unit: string) =>
    v !== null ? `${v.toFixed(1)} ${unit}` : '—';

  const hrBpm: number | null = hrOverride
    ? parseFloat(hrOverride) || null
    : hrFromDicom.bpm;

  const coDisplay = (() => {
    if (hrBpm === null || metrics.strokeVolumeMl === null) return 'Value missing';
    return `${COComputer.computeCO(metrics.strokeVolumeMl, hrBpm).toFixed(1)} L/min`;
  })();

  const hrDisplay = hrFromDicom.bpm !== null && !hrOverride
    ? `${hrFromDicom.bpm.toFixed(0)} bpm`
    : null;

  // ── render ─────────────────────────────────────────────────────────────────

  const tabs = [
    { id: 'metrics' as const, label: 'Metrics' },
    { id: 'vtc' as const, label: 'VTC' },
    { id: 'wallthickness' as const, label: 'Wall Thickness' },
  ];

  return (
    <div
      className="flex h-full w-full flex-col bg-black text-white"
      data-testid="cardiac-viewer-panel"
      data-cy="cardiac-viewer-panel"
    >
      {/* ── TOP: ROI Preview (persistent) ── */}
      <div className="flex-shrink-0 border-b border-gray-700 p-3">
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold" style={{ color: MEDEX_ORANGE }}>
            ROI Preview
          </h3>
        </div>

        {/* Canvas 4:3 */}
        <div
          className="relative mb-3 flex items-center justify-center rounded border border-gray-700 bg-gray-900"
          style={{ aspectRatio: '4/3' }}
        >
          {roiPreviewUrl ? (
            <img src={roiPreviewUrl} className="h-full w-full object-contain" alt="ROI preview" />
          ) : (
            <div className="text-center text-gray-500">
              <svg className="mx-auto mb-2 h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="16" rx="2" strokeWidth="2" className="text-gray-600" />
                <path d="M12 8v8m-4-4h8" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <p className="text-xs">No ROI Selected</p>
              <p className="mt-1 text-[10px]" style={{ color: MEDEX_ORANGE }}>
                Click to draw Analysis ROI
              </p>
            </div>
          )}
          {/* ED / ES buttons */}
          <div className="absolute right-2 top-2 flex gap-1">
            <button
              data-testid="ed-button"
              data-cy="ed-button"
              disabled={phase.edFrame < 0}
              onClick={() => jumpToFrame(phase.edFrame)}
              className="rounded bg-green-800 px-2 py-0.5 text-xs font-bold text-white disabled:opacity-40 hover:bg-green-700"
            >
              ED
            </button>
            <button
              data-testid="es-button"
              data-cy="es-button"
              disabled={phase.esFrame < 0}
              onClick={() => jumpToFrame(phase.esFrame)}
              className="rounded bg-yellow-700 px-2 py-0.5 text-xs font-bold text-white disabled:opacity-40 hover:bg-yellow-600"
            >
              ES
            </button>
          </div>
        </div>

        {/* Labels 2-col grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {CVI_LABELS.map(label => {
            const isVisible = cviState.labelVisibility?.[label.id] ?? true;
            return (
              <div key={label.id} className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors"
                  onClick={() => toggleLabelVisibility(label.id)}
                  style={{ color: label.color }}
                  data-testid={`label-visibility-${label.id}`}
                  data-cy={`label-visibility-${label.id}`}
                  title={isVisible ? 'Hide' : 'Show'}
                >
                  {isVisible ? (
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                      <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                      <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                      <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clipRule="evenodd" />
                      <path d="m10.748 13.93 2.523 2.523a10.003 10.003 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
                    </svg>
                  )}
                </button>
                <span
                  style={{ color: label.color }}
                  data-testid={`label-${label.id}`}
                  data-cy={`label-${label.id}`}
                >
                  {label.name}
                </span>
              </div>
            );
          })}
        </div>

        {/* ADVANCED collapsible */}
        <div className="mt-3 flex flex-col">
          <button
            type="button"
            className="flex w-full items-center justify-between py-1 text-[10px] font-medium uppercase tracking-wide text-gray-500 hover:text-gray-300"
            onClick={() => setAdvancedOpen(o => !o)}
          >
            <span>Advanced</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-3 w-3 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
            >
              <path
                fillRule="evenodd"
                d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          {advancedOpen && (
            <div className="flex flex-col gap-3 pt-2">
              <div className="text-xs">
                <label className="mb-1 block text-gray-400">Segmentation Model</label>
                <div className="flex items-center gap-2">
                  <select
                    className="flex-1 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-200"
                    value="manual"
                    disabled
                  >
                    <option value="manual">Manual</option>
                  </select>
                </div>
                <p className="mt-1 text-[10px] text-yellow-500">
                  ⚠ Backend unavailable — only Manual mode is available
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── BOTTOM: Tabbed section ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Tab bar */}
        <div className="flex flex-shrink-0 border-b border-gray-700 bg-gray-900">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-2 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-b-2 text-white'
                  : 'border-b-2 border-transparent text-gray-400 hover:text-gray-200'
              }`}
              style={{ borderBottomColor: activeTab === tab.id ? MEDEX_ORANGE : 'transparent' }}
              data-testid={`tab-${tab.id}`}
              data-cy={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Active tab content */}
        <div className="flex-1 overflow-y-auto p-2">
          {activeTab === 'metrics' && (
            <div className="space-y-3">
              {singleSliceWarning && (
                <div className="text-center text-xs text-yellow-400">
                  Single-slice approximation — load full short-axis stack for accurate volumes
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <MetricValue label="EF"  value={metrics.ef !== null ? `${metrics.ef.toFixed(1)}%` : '—'} testId="metric-ef" />
                <MetricValue label="EDV" value={fmt(metrics.edvMl, 'mL')} testId="metric-edv" />
                <MetricValue label="ESV" value={fmt(metrics.esvMl, 'mL')} testId="metric-esv" />
                <MetricValue label="SV"  value={fmt(metrics.strokeVolumeMl, 'mL')} testId="metric-sv" />
              </div>
              {/* HR input + CO */}
              <div className="rounded border border-gray-700 bg-gray-900 p-2 text-xs">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-gray-400" title="Heart Rate">
                    HR {hrFromDicom.source ? `(${hrFromDicom.source})` : ''}
                  </span>
                  <div className="flex items-center gap-1">
                    {hrDisplay && !hrOverride && (
                      <span className="text-white">{hrDisplay}</span>
                    )}
                    <input
                      data-testid="hr-input"
                      data-cy="hr-input"
                      type="number"
                      min={20}
                      max={300}
                      value={hrOverride}
                      onChange={e => setHrOverride(e.target.value)}
                      placeholder={hrDisplay ?? 'Enter bpm'}
                      className="w-20 rounded border border-gray-600 bg-gray-800 px-1 py-0.5 text-white placeholder-gray-500"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400" title="Cardiac Output">CO</span>
                  <span className="text-white" data-testid="metric-co" data-cy="metric-co">
                    {coDisplay}
                  </span>
                </div>
              </div>
            </div>
          )}
          {activeTab === 'vtc' && (
            <VolumeTimeCurveChart
              lvSeries={volumeSeriesLV}
              rvSeries={volumeSeriesRV}
              edFrame={phase.edFrame}
              esFrame={phase.esFrame}
              currentFrame={currentFrame}
              onFrameClick={jumpToFrame}
            />
          )}
          {activeTab === 'wallthickness' && (
            <WallThicknessChart series={wallThicknessMm} currentFrame={currentFrame} />
          )}
        </div>
      </div>

      {/* hidden canvas for off-screen ROI rendering */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default CardiacViewerPanel;
