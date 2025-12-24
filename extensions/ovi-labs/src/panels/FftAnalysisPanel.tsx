import React from 'react';

interface FftAnalysisPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

/**
 * FFT Analysis Panel - Placeholder
 *
 * Future features:
 * - Frequency spectrum plot (major/minor axis)
 * - Dominant frequency display
 * - Motion phase classification (OP/LP/MP)
 * - Export plot functionality
 */
const FftAnalysisPanel: React.FC<FftAnalysisPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  return (
    <div className="flex h-full w-full flex-col bg-black p-4 text-white">
      <h2 className="mb-4 text-lg font-semibold" style={{ color: '#F47620' }}>
        FFT Analysis
      </h2>
      <div className="flex flex-1 items-center justify-center rounded border border-gray-700 bg-gray-900">
        <div className="text-center">
          <p className="mb-2 text-gray-400">Frequency Spectrum</p>
          <p className="text-sm text-gray-500">Coming Soon</p>
          <p className="mt-4 text-xs text-gray-600">
            This panel will show FFT analysis
            <br />
            with dominant frequency and motion phase.
          </p>
        </div>
      </div>
    </div>
  );
};

export default FftAnalysisPanel;
