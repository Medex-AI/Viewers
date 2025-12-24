import React from 'react';
import {
  RoiViewerPanel,
  FftAnalysisPanel,
  KymographsPanel,
  AnalysisPlotsPanel,
} from './panels';

export default function getPanelModule({
  commandsManager,
  servicesManager,
  extensionManager,
}: withAppTypes) {
  const childProps = {
    commandsManager,
    servicesManager,
    extensionManager,
  };

  return [
    {
      name: 'roiViewer',
      iconName: 'tab-roi-threshold',
      iconLabel: 'ROI',
      label: 'ROI Viewer',
      component: () => <RoiViewerPanel {...childProps} />,
    },
    {
      name: 'fftAnalysis',
      iconName: 'tab-linear',
      iconLabel: 'FFT',
      label: 'FFT Analysis',
      component: () => <FftAnalysisPanel {...childProps} />,
    },
    {
      name: 'kymographs',
      iconName: 'tab-patient-info',
      iconLabel: 'Kymo',
      label: 'Kymographs',
      component: () => <KymographsPanel {...childProps} />,
    },
    {
      name: 'analysisPlots',
      iconName: 'tab-studies',
      iconLabel: 'Plots',
      label: 'Analysis Plots',
      component: () => <AnalysisPlotsPanel {...childProps} />,
    },
  ];
}
