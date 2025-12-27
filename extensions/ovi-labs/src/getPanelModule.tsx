import React from 'react';
import { AnalysisContainerPanel } from './panels';

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
  ];
}
