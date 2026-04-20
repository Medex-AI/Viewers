import React from 'react';
import SegmentationExportControls from '../components/segmentation/SegmentationExportControls';

interface SegmentationExportPanelProps {
  servicesManager?: any;
}

const SegmentationExportPanel: React.FC<SegmentationExportPanelProps> = ({ servicesManager }) => {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-black text-white">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <h3 className="text-sm font-medium">Export</h3>
      </div>
      <div className="p-3">
        <SegmentationExportControls servicesManager={servicesManager} />
      </div>
    </div>
  );
};

export default SegmentationExportPanel;
