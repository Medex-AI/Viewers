import { CustomDropdownMenuContent } from './CustomDropdownMenuContent';
import { CustomSegmentStatisticsHeader } from './CustomSegmentStatisticsHeader';
import { SegmentCardsList } from './SegmentCardsList';

export default function getSegmentationPanelCustomization({ commandsManager, servicesManager }) {
  return {
    'panelSegmentation.customDropdownMenuContent': CustomDropdownMenuContent,
    'panelSegmentation.customSegmentStatisticsHeader': CustomSegmentStatisticsHeader,
    'panelSegmentation.customSegmentsList': SegmentCardsList,
    'panelSegmentation.disableEditing': false,
    'panelSegmentation.showAddSegment': true,
    'panelSegmentation.onSegmentationAdd': () => {
      const { viewportGridService } = servicesManager.services;
      const { activeViewportId, viewports } = viewportGridService.getState();
      const viewportId = activeViewportId || Array.from(viewports?.keys?.() ?? [])[0];
      if (!viewportId) {
        return;
      }
      commandsManager.run('createLabelmapForViewport', {
        viewportId,
        options: { createInitialSegment: true },
      });
    },
    'panelSegmentation.tableMode': 'collapsed',
    'panelSegmentation.readableText': {
      // the values will appear in this order
      min: 'Min Value',
      minLPS: 'Min Coord',
      max: 'Max Value',
      maxLPS: 'Max Coord',
      mean: 'Mean Value',
      stdDev: 'Standard Deviation',
      count: 'Voxel Count',
      median: 'Median',
      skewness: 'Skewness',
      kurtosis: 'Kurtosis',
      peakValue: 'Peak Value',
      peakLPS: 'Peak Coord',
      volume: 'Volume',
      lesionGlycolysis: 'Lesion Glycolysis',
      center: 'Center',
    },
  };
}
