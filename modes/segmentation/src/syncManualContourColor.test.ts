jest.mock('@cornerstonejs/tools', () => ({
  annotation: {
    config: {
      style: {
        getToolGroupToolStyles: jest.fn(),
        setToolGroupToolStyles: jest.fn(),
      },
    },
  },
  ToolGroupManager: {
    getAllToolGroups: jest.fn(),
  },
}));

import { annotation, ToolGroupManager } from '@cornerstonejs/tools';
import { syncManualContourColor } from './syncManualContourColor';

describe('syncManualContourColor', () => {
  const mockGetToolGroupToolStyles = annotation.config.style.getToolGroupToolStyles as jest.Mock;
  const mockSetToolGroupToolStyles = annotation.config.style.setToolGroupToolStyles as jest.Mock;
  const mockGetAllToolGroups = ToolGroupManager.getAllToolGroups as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetToolGroupToolStyles.mockReturnValue({});
    mockGetAllToolGroups.mockReturnValue([
      { id: 'default' },
      { id: 'mpr' },
      { id: 'mpr-viewport-2' },
    ]);
    delete (window as any).__oviActiveManualContourColor;
  });

  it('uses the active segment from the changed segmentation, not the active viewport fallback', () => {
    const segmentationService = {
      getSegmentation: jest.fn(() => ({
        segments: {
          1: { segmentIndex: 1, active: false },
          2: { segmentIndex: 2, active: true },
        },
      })),
      getActiveSegment: jest.fn(() => ({ segmentIndex: 1, active: true })),
      getSegmentationRepresentations: jest.fn(() => []),
      getSegmentColor: jest.fn(() => [251, 191, 36, 255]),
    };

    syncManualContourColor('viewport-0', 'segmentation-a', segmentationService);

    expect((window as any).__oviActiveManualContourColor).toBe('#fbbf24');
    expect(segmentationService.getActiveSegment).not.toHaveBeenCalled();
    expect(mockSetToolGroupToolStyles).toHaveBeenCalledTimes(3);
    for (const [, styles] of mockSetToolGroupToolStyles.mock.calls) {
      expect(styles.ManualContour).toMatchObject({
        color: '#fbbf24',
        colorHighlighted: '#fbbf24',
        colorSelected: '#fbbf24',
        fillColor: '#fbbf24',
      });
    }
  });

  it('falls back to the viewport active segment when segmentation state is not populated', () => {
    const segmentationService = {
      getSegmentation: jest.fn(() => null),
      getActiveSegment: jest.fn(() => ({ segmentIndex: 3, active: true })),
      getSegmentationRepresentations: jest.fn(() => []),
      getSegmentColor: jest.fn(() => [239, 68, 68, 255]),
    };

    syncManualContourColor('viewport-0', 'segmentation-a', segmentationService);

    expect((window as any).__oviActiveManualContourColor).toBe('#ef4444');
    expect(segmentationService.getSegmentColor).toHaveBeenCalledWith(
      'viewport-0',
      'segmentation-a',
      3
    );
  });
});
