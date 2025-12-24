import React from 'react';

interface AnalysisPlotsPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

/**
 * Analysis Plots Panel - Placeholder
 *
 * Future features:
 * - Area vs time plot
 * - Major/minor axes length vs time
 * - Circumference vs time
 * - Export plots and data
 */
const AnalysisPlotsPanel: React.FC<AnalysisPlotsPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  return (
    <div className="flex h-full w-full flex-col bg-black p-4 text-white">
      <h2 className="mb-4 text-lg font-semibold" style={{ color: '#F47620' }}>
        Analysis Plots
      </h2>
      <div className="flex flex-1 items-center justify-center rounded border border-gray-700 bg-gray-900">
        <div className="text-center">
          <p className="mb-2 text-gray-400">Temporal Measurements</p>
          <p className="text-sm text-gray-500">Coming Soon</p>
          <p className="mt-4 text-xs text-gray-600">
            This panel will show area, axes, and
            <br />
            circumference measurements over time.
          </p>
        </div>
      </div>
    </div>
  );
};

export default AnalysisPlotsPanel;
