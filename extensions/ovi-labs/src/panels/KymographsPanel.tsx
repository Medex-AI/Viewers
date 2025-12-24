import React from 'react';

interface KymographsPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

/**
 * Kymographs Panel - Placeholder
 *
 * Future features:
 * - X-t and Y-t kymograph visualization
 * - Colormap selection
 * - Axis selection (major/minor)
 * - Export kymograph image
 */
const KymographsPanel: React.FC<KymographsPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  return (
    <div className="flex h-full w-full flex-col bg-black p-4 text-white">
      <h2 className="mb-4 text-lg font-semibold" style={{ color: '#F47620' }}>
        Kymographs
      </h2>
      <div className="flex flex-1 items-center justify-center rounded border border-gray-700 bg-gray-900">
        <div className="text-center">
          <p className="mb-2 text-gray-400">Space-Time Visualization</p>
          <p className="text-sm text-gray-500">Coming Soon</p>
          <p className="mt-4 text-xs text-gray-600">
            This panel will generate kymographs
            <br />
            showing motion patterns over time.
          </p>
        </div>
      </div>
    </div>
  );
};

export default KymographsPanel;
