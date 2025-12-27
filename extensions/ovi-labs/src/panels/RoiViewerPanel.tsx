import React from 'react';

interface RoiViewerPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

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
  return (
    <div className="flex w-full flex-col bg-black p-3 text-white">
      <h3 className="mb-2 text-sm font-semibold" style={{ color: '#F47620' }}>
        ROI Preview
      </h3>

      {/* ROI Preview Area - 4:3 aspect ratio */}
      <div className="mb-3 flex items-center justify-center rounded border border-gray-700 bg-gray-900" style={{ aspectRatio: '4/3' }}>
        <div className="text-center text-gray-500">
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
