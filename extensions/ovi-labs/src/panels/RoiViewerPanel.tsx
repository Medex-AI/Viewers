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
    <div className="flex h-full w-full flex-col bg-black p-4 text-white">
      <h2 className="mb-4 text-lg font-semibold" style={{ color: '#F47620' }}>
        ROI Viewer
      </h2>
      <div className="flex flex-1 items-center justify-center rounded border border-gray-700 bg-gray-900">
        <div className="text-center">
          <p className="mb-2 text-gray-400">ROI Preview</p>
          <p className="text-sm text-gray-500">Coming Soon</p>
          <p className="mt-4 text-xs text-gray-600">
            This panel will display the oriented ROI region
            <br />
            with optional segmentation overlay.
          </p>
        </div>
      </div>
    </div>
  );
};

export default RoiViewerPanel;
