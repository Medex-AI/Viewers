import React from 'react';
import { Types } from '@ohif/core';
import CardiacViewerPanel from './panels/CardiacViewerPanel';
import CviSegmentationPanel from './panels/CviSegmentationPanel';

const CviLabsExtension: Types.Extensions.Extension = {
  id: '@medex/cvi-labs',

  getPanelModule({ commandsManager, servicesManager }: withAppTypes) {
    return [
      {
        name: 'cardiacViewer',
        iconName: 'tab-linear',
        iconLabel: 'Cardiac',
        label: 'Cvi Labs Analysis',
        component: () =>
          React.createElement(CardiacViewerPanel, { commandsManager, servicesManager }),
      },
      {
        name: 'segmentation',
        iconName: 'tab-segmentation',
        iconLabel: 'Segmentation',
        label: 'Segmentation',
        component: () => React.createElement(CviSegmentationPanel, { servicesManager }),
      },
    ];
  },
};

export default CviLabsExtension;

export { default as CardiacViewerPanel } from './panels/CardiacViewerPanel';
export { default as CviSegmentationPanel } from './panels/CviSegmentationPanel';
export { default as VolumeTimeCurveChart } from './panels/VolumeTimeCurveChart';
export { default as WallThicknessChart } from './panels/WallThicknessChart';
export { CVI_LABELS, getCviLabsState, subscribeCviLabs, resetCviLabsState, setCviLabelVisibility } from './stores/cviLabsSegmentationStore';
export * from './analysis';
