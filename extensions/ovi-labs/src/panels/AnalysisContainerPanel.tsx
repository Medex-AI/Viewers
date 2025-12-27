import React, { useState } from 'react';
import RoiViewerPanel from './RoiViewerPanel';
import FftAnalysisPanel from './FftAnalysisPanel';
import KymographsPanel from './KymographsPanel';
import AnalysisPlotsPanel from './AnalysisPlotsPanel';

interface AnalysisContainerPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

type TabId = 'fft' | 'kymograph' | 'plots';

interface Tab {
  id: TabId;
  label: string;
  icon?: string;
  component: React.ComponentType<any>;
}

/**
 * Analysis Container Panel - Composite panel with persistent ROI viewer and tabbed analysis views
 *
 * Layout:
 * - Top: ROI Viewer (always visible)
 * - Bottom: Tabbed interface (FFT, Kymograph, Analysis Plots)
 */
const AnalysisContainerPanel: React.FC<AnalysisContainerPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('fft');

  const tabs: Tab[] = [
    {
      id: 'fft',
      label: 'FFT',
      component: FftAnalysisPanel,
    },
    {
      id: 'kymograph',
      label: 'Kymograph',
      component: KymographsPanel,
    },
    {
      id: 'plots',
      label: 'Plots',
      component: AnalysisPlotsPanel,
    },
  ];

  const ActiveTabComponent = tabs.find(tab => tab.id === activeTab)?.component || FftAnalysisPanel;

  const childProps = {
    commandsManager,
    servicesManager,
    extensionManager,
  };

  return (
    <div className="flex h-full w-full flex-col bg-black">
      {/* Persistent ROI Viewer at Top */}
      <div className="flex-shrink-0 border-b border-gray-700">
        <RoiViewerPanel {...childProps} />
      </div>

      {/* Tabbed Analysis Section */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Tab Navigation */}
        <div className="flex flex-shrink-0 border-b border-gray-700 bg-gray-900">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                flex-1 px-4 py-3 text-sm font-medium transition-colors
                ${
                  activeTab === tab.id
                    ? 'border-b-2 text-white'
                    : 'border-b-2 border-transparent text-gray-400 hover:text-gray-200'
                }
              `}
              style={{
                borderBottomColor: activeTab === tab.id ? '#F47620' : 'transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Active Tab Content */}
        <div className="flex-1 overflow-auto">
          <ActiveTabComponent {...childProps} />
        </div>
      </div>
    </div>
  );
};

export default AnalysisContainerPanel;
