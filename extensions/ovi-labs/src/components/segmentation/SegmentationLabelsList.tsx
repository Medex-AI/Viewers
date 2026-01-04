import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { DicomMetadataStore } from '@ohif/core';
import {
  SegmentationLabel,
  getSegmentationState,
  setLabelVisibility,
  setLabelOpacity,
  deleteAllTimePoints,
  deleteCurrentTimePoint,
  subscribeSegmentationState,
} from '../../utils/segmentationStore';
import SegmentationThumbnail from './SegmentationThumbnail';
import { getRoiSegmentationFrame } from '../../utils/roiSegmentationStore';
import { calculateLabelAreas } from '../../utils/areaCalculator';

interface SegmentationLabelsListProps {
  servicesManager?: any;
  activeViewportId?: string;
  roiAnnotation?: any;
  revision?: number;
  currentImageId?: string; // Current frame's image ID
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  labelId: string | null;
}

const SegmentationLabelsList: React.FC<SegmentationLabelsListProps> = ({
  servicesManager,
  activeViewportId,
  roiAnnotation,
  revision = 0,
  currentImageId,
}) => {
  const [labels, setLabels] = useState<SegmentationLabel[]>(getSegmentationState().labels);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    labelId: null,
  });
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const uiNotificationService = servicesManager?.services?.uiNotificationService;

  // Check if label has annotation on current frame
  const hasAnnotationOnCurrentFrame = useCallback(
    (label: SegmentationLabel) => {
      if (!currentImageId) return false;
      return label.annotations.some(ref => ref.referencedImageId === currentImageId);
    },
    [currentImageId]
  );

  const labelAreas = useMemo(() => {
    if (!currentImageId) {
      return new Map();
    }

    const instance = DicomMetadataStore.getInstanceByImageId(currentImageId);
    const seriesInstanceUID = instance?.SeriesInstanceUID;
    if (!seriesInstanceUID) {
      return new Map();
    }

    const frameKey = currentImageId;
    const frame = getRoiSegmentationFrame(seriesInstanceUID, frameKey);
    if (!frame) {
      return new Map();
    }

    const areas = calculateLabelAreas(frame);
    return new Map(areas.map(area => [area.labelId, area]));
  }, [currentImageId, revision, roiAnnotation]);

  useEffect(() => {
    const unsubscribe = subscribeSegmentationState(state => {
      setLabels(state.labels);
    });
    return unsubscribe;
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu.visible) return;

    const handleClick = (evt: MouseEvent) => {
      if (!contextMenuRef.current?.contains(evt.target as Node)) {
        setContextMenu(prev => ({ ...prev, visible: false }));
      }
    };

    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [contextMenu.visible]);

  const handleContextMenu = (e: React.MouseEvent, labelId: string) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      labelId,
    });
  };

  const handleDeleteCurrentFrame = () => {
    if (contextMenu.labelId && currentImageId) {
      deleteCurrentTimePoint(contextMenu.labelId, currentImageId);
      uiNotificationService?.show?.({
        title: 'Time Point Deleted',
        message: 'Contour for current time frame has been removed',
        type: 'info',
        duration: 2000,
      });
    }
    setContextMenu(prev => ({ ...prev, visible: false }));
  };

  const handleDeleteAllFrames = () => {
    if (contextMenu.labelId) {
      deleteAllTimePoints(contextMenu.labelId);
      uiNotificationService?.show?.({
        title: 'Label Deleted',
        message: 'All contours for this label have been removed',
        type: 'info',
        duration: 2000,
      });
    }
    setContextMenu(prev => ({ ...prev, visible: false }));
  };

  const handleVisibilityChange = (labelId: string, visible: boolean) => {
    setLabelVisibility(labelId, visible);
  };

  const handleOpacityChange = (labelId: string, opacity: number) => {
    setLabelOpacity(labelId, opacity);
  };

  // Group labels by method
  const labelsByMethod = labels.reduce(
    (acc, label) => {
      const method = label.method || 'manual';
      if (!acc[method]) {
        acc[method] = [];
      }
      acc[method].push(label);
      return acc;
    },
    {} as Record<string, SegmentationLabel[]>
  );

  const methodDisplayNames: Record<string, string> = {
    manual: 'Manual Contours',
    threshold: 'Threshold',
    medsam: 'MedSAM',
    unet_uterine: 'UNet-Uterine',
  };

  // Slider styles for cross-browser thumb visibility
  const sliderStyles = `
    .segmentation-opacity-slider {
      -webkit-appearance: none;
      appearance: none;
      background: #374151;
      border-radius: 4px;
      height: 6px;
      accent-color: #38bdf8;
    }
    .segmentation-opacity-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #f8fafc;
      cursor: pointer;
      border: 2px solid #38bdf8;
      box-shadow: 0 0 0 1px #0b1220, 0 0 0 3px rgba(15, 23, 42, 0.35);
      margin-top: -5px;
    }
    .segmentation-opacity-slider::-moz-range-thumb {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #f8fafc;
      cursor: pointer;
      border: 2px solid #38bdf8;
      box-shadow: 0 0 0 1px #0b1220, 0 0 0 3px rgba(15, 23, 42, 0.35);
    }
    .segmentation-opacity-slider::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 4px;
      background: #374151;
    }
    .segmentation-opacity-slider::-moz-range-track {
      height: 6px;
      border-radius: 4px;
      background: #374151;
    }
    .segmentation-opacity-slider::-ms-track {
      height: 6px;
      border-radius: 4px;
      background: #374151;
      border: none;
      color: transparent;
    }
    .segmentation-opacity-slider::-ms-thumb {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #f8fafc;
      border: 2px solid #38bdf8;
    }
  `;

  if (labels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-gray-500">
        <svg
          className="mb-2 h-8 w-8"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
          />
        </svg>
        <p className="text-xs">No segmentation labels</p>
        <p className="mt-1 text-[10px] text-gray-600">
          Use the Manual Contour tool to draw labels
        </p>
      </div>
    );
  }

  return (
    <>
      <style>{sliderStyles}</style>
      <div className="flex flex-col gap-3">
        {Object.entries(labelsByMethod).map(([method, groupLabels]) => (
        <div key={method} className="flex flex-col gap-1">
          {/* Method Group Header */}
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-gray-500">
            <span>{methodDisplayNames[method] || method}</span>
            <span className="text-gray-600">({groupLabels.length})</span>
          </div>

          {/* Labels in this group */}
          <div className="flex flex-col gap-1">
            {groupLabels.map(label => (
              <div
                key={label.id}
                className="group flex items-center gap-2 rounded border border-gray-800 bg-gray-900 p-2 hover:border-gray-700"
                onContextMenu={e => handleContextMenu(e, label.id)}
              >
                {/* Thumbnail with segmentation overlay */}
                <SegmentationThumbnail
                  label={label}
                  servicesManager={servicesManager}
                  activeViewportId={activeViewportId}
                  roiAnnotation={roiAnnotation}
                  size={40}
                  revision={revision}
                />

                {/* Label name with time frame count */}
                <div className="flex flex-1 flex-col truncate">
                  <span className="text-xs" style={{ color: label.color }}>
                    {label.name}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {label.annotations.length} frame{label.annotations.length !== 1 ? 's' : ''}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {labelAreas.has(label.id)
                      ? `${labelAreas.get(label.id)?.area.toFixed(1)} ${labelAreas.get(label.id)?.unit}`
                      : 'Area: --'}
                  </span>
                </div>

                {/* Visibility checkbox */}
                <label className="flex cursor-pointer items-center" title="Toggle visibility">
                  <input
                    type="checkbox"
                    checked={label.visible}
                    onChange={e => handleVisibilityChange(label.id, e.target.checked)}
                    className="sr-only"
                  />
                  <div
                    className={`flex h-5 w-5 items-center justify-center rounded transition-colors ${
                      label.visible
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-500'
                    }`}
                  >
                    {label.visible ? (
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                        />
                      </svg>
                    ) : (
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                        />
                      </svg>
                    )}
                  </div>
                </label>

                {/* Opacity slider */}
                <div className="flex w-24 flex-col gap-1" title={`Opacity: ${Math.round(label.opacity * 100)}%`}>
                  <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
                    Opacity
                  </span>
                  <div className="flex items-center gap-1">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(label.opacity * 100)}
                      onChange={e => handleOpacityChange(label.id, parseInt(e.target.value, 10) / 100)}
                      className="segmentation-opacity-slider w-full cursor-pointer"
                    />
                    <span className="w-6 text-right text-[10px] text-gray-500">
                      {Math.round(label.opacity * 100)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Context Menu */}
      {contextMenu.visible && (() => {
        const selectedLabel = labels.find(l => l.id === contextMenu.labelId);
        const canDeleteCurrentFrame = selectedLabel && currentImageId && hasAnnotationOnCurrentFrame(selectedLabel);

        return (
          <div
            ref={contextMenuRef}
            className="fixed z-50 rounded border border-gray-700 bg-gray-900 py-1 shadow-lg"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {/* Delete Current Time Point */}
            <button
              type="button"
              onClick={handleDeleteCurrentFrame}
              disabled={!canDeleteCurrentFrame}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                canDeleteCurrentFrame
                  ? 'text-orange-400 hover:bg-gray-800'
                  : 'cursor-not-allowed text-gray-600'
              }`}
              title={canDeleteCurrentFrame ? 'Delete contour on current frame only' : 'No contour on current frame'}
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span>Delete Current Frame</span>
            </button>

            {/* Delete All Time Points */}
            <button
              type="button"
              onClick={handleDeleteAllFrames}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-gray-800"
              title="Delete contours on all frames"
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              <span>Delete All Frames ({selectedLabel?.annotations.length || 0})</span>
            </button>
          </div>
        );
      })()}
      </div>
    </>
  );
};

export default SegmentationLabelsList;
