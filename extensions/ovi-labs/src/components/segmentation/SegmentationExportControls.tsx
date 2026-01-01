import React, { useState, useEffect } from 'react';
import { getSegmentationState, subscribeSegmentationState } from '../../utils/segmentationStore';

interface SegmentationExportControlsProps {
  servicesManager?: any;
}

const SegmentationExportControls: React.FC<SegmentationExportControlsProps> = ({
  servicesManager,
}) => {
  const [hasLabels, setHasLabels] = useState(getSegmentationState().labels.length > 0);
  const [isExporting, setIsExporting] = useState(false);

  const uiNotificationService = servicesManager?.services?.uiNotificationService;

  useEffect(() => {
    const unsubscribe = subscribeSegmentationState(state => {
      setHasLabels(state.labels.length > 0);
    });
    return unsubscribe;
  }, []);

  const handleExport = async () => {
    if (!hasLabels) return;

    setIsExporting(true);

    // Stub implementation - show notification
    uiNotificationService?.show?.({
      title: 'Export',
      message: 'NIfTI export coming in Task 4.8.5',
      type: 'info',
      duration: 3000,
    });

    // Simulate export delay
    await new Promise(resolve => setTimeout(resolve, 500));
    setIsExporting(false);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-gray-800 pt-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-gray-200">Export</span>
          <span className="text-[10px] text-gray-500">
            ROI image + segmentation mask (NIfTI)
          </span>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={!hasLabels || isExporting}
          className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs transition-colors ${
            hasLabels && !isExporting
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'cursor-not-allowed bg-gray-700 text-gray-500'
          }`}
          title={!hasLabels ? 'No labels to export' : 'Export as NIfTI'}
        >
          {isExporting ? (
            <svg
              className="h-3 w-3 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          ) : (
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
          )}
          <span>{isExporting ? 'Exporting...' : 'Download'}</span>
        </button>
      </div>
    </div>
  );
};

export default SegmentationExportControls;
