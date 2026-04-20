import React from 'react';
import { AnalysisContainerPanel, SegmentationPanel, SegmentationExportPanel } from './panels';

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
      name: 'analysisContainer',
      iconName: 'tab-linear',
      iconLabel: 'Analysis',
      label: 'Ovi Labs Analysis',
      component: () => <AnalysisContainerPanel {...childProps} />,
    },
    {
      name: 'segmentation',
      iconName: 'tab-segmentation',
      iconLabel: 'Segmentation',
      label: 'Segmentation',
      component: () => <SegmentationPanel {...childProps} />,
    },
    {
      name: 'segmentationExport',
      iconName: 'Export',
      iconLabel: 'Export',
      label: 'Export',
      component: () => <SegmentationExportPanel {...childProps} />,
    },
  ];
}
