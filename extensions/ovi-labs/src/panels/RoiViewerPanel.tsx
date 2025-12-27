import React, { useEffect, useState } from 'react';
import { eventTarget } from '@cornerstonejs/core';
import { annotation, Enums } from '@cornerstonejs/tools';

interface RoiViewerPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

const TOOL_NAME = 'RotatableRectangleROI';
const TOOL_GROUP_ID = 'default';
const MEDEX_ORANGE = '#F47620';

/**
 * ROI Viewer Panel - Placeholder
 *
 * Future features:
 * - Display oriented ROI region preview
 * - Show current frame's ROI content
 * - Optional segmentation mask overlay
 * - Orientation indicator
 */
const RoiViewerPanel: React.FC<RoiViewerPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  const [roiAnnotation, setRoiAnnotation] = useState<any>(null);

  const getFirstAnalysisRoi = () => {
    const annotationManager = annotation.state.getAnnotationManager();
    if (!annotationManager?.getFramesOfReference) {
      return null;
    }

    const framesOfReference = annotationManager.getFramesOfReference() || [];
    for (const frameOfReference of framesOfReference) {
      const annotations = annotationManager.getAnnotations(frameOfReference, TOOL_NAME) || [];
      if (annotations.length) {
        return annotations[0];
      }
    }

    return null;
  };

  useEffect(() => {
    const updateRoiState = () => {
      setRoiAnnotation(getFirstAnalysisRoi());
    };

    updateRoiState();

    const addedEvt = Enums.Events.ANNOTATION_ADDED;
    const modifiedEvt = Enums.Events.ANNOTATION_MODIFIED;
    const removedEvt = Enums.Events.ANNOTATION_REMOVED;

    eventTarget.addEventListener(addedEvt, updateRoiState);
    eventTarget.addEventListener(modifiedEvt, updateRoiState);
    eventTarget.addEventListener(removedEvt, updateRoiState);

    return () => {
      eventTarget.removeEventListener(addedEvt, updateRoiState);
      eventTarget.removeEventListener(modifiedEvt, updateRoiState);
      eventTarget.removeEventListener(removedEvt, updateRoiState);
    };
  }, []);

  const hasAnalysisRoi = !!roiAnnotation;

  const handleActivateTool = () => {
    commandsManager?.run?.('setToolActive', {
      toolName: TOOL_NAME,
      toolGroupId: TOOL_GROUP_ID,
    });
  };

  return (
    <div className="flex w-full flex-col bg-black p-3 text-white">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: MEDEX_ORANGE }}>
          ROI Preview
        </h3>
      </div>

      {/* ROI Preview Area - 4:3 aspect ratio */}
      <div
        className={`mb-3 flex items-center justify-center rounded border border-gray-700 bg-gray-900 ${
          !hasAnalysisRoi ? 'cursor-pointer hover:border-gray-500' : ''
        }`}
        style={{ aspectRatio: '4/3' }}
        onClick={!hasAnalysisRoi ? handleActivateTool : undefined}
        role={!hasAnalysisRoi ? 'button' : undefined}
        tabIndex={!hasAnalysisRoi ? 0 : undefined}
        onKeyDown={
          !hasAnalysisRoi
            ? evt => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  handleActivateTool();
                }
              }
            : undefined
        }
      >
        <div className="text-center text-gray-500">
          {!hasAnalysisRoi ? (
            <>
              <svg
                className="mx-auto mb-2 h-12 w-12"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <rect
                  x="4"
                  y="4"
                  width="16"
                  height="16"
                  rx="2"
                  strokeWidth="2"
                  className="text-gray-600"
                />
                <path
                  d="M12 8v8m-4-4h8"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <p className="text-xs">No ROI Selected</p>
              <p className="mt-1 text-[10px]" style={{ color: MEDEX_ORANGE }}>
                Click to draw Analysis ROI
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-gray-200">Analysis ROI Selected</p>
              <p className="mt-1 text-[10px] text-gray-400">
                Preview rendering coming in Phase 4
              </p>
            </>
          )}
        </div>
      </div>

      {/* ROI Controls */}
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <label className="flex items-center text-gray-400">
            <input
              type="checkbox"
              className="mr-2 rounded border-gray-600"
              disabled
            />
            Show Segmentation
          </label>
        </div>
        <div className="flex items-center justify-between">
          <label className="flex items-center text-gray-400">
            <input
              type="checkbox"
              className="mr-2 rounded border-gray-600"
              defaultChecked
              disabled
            />
            Show Orientation
          </label>
        </div>
      </div>
    </div>
  );
};

export default RoiViewerPanel;
