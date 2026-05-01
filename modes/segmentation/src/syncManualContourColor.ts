import { annotation, ToolGroupManager } from '@cornerstonejs/tools';

const TOOL_NAME = 'ManualContour';
const FILL_OPACITY = 0.2;

const rgbaToHex = (rgba: [number, number, number, number]): string => {
  const [r, g, b] = rgba;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

/**
 * Reads the active segment color from the segmentation service and syncs it to:
 * 1. window.__oviActiveManualContourColor — read by ManualContourTool when completing annotations
 * 2. Tool group styles — so new drawings use the active segment color for stroke + fill
 *
 * Mirrors the applyToolGroupStyle() pattern used in ovi-labs setupManualContourBehavior.ts.
 */
export const syncManualContourColor = (
  viewportId: string,
  segmentationId: string,
  segmentationService: any
): void => {
  try {
    const segmentation = segmentationService.getSegmentation?.(segmentationId);
    const activeSegment =
      Object.values(segmentation?.segments ?? {}).find((segment: any) => segment?.active) ||
      segmentationService.getActiveSegment(viewportId);
    // Segment indices are 1-based; 0/undefined/null means no active segment
    const segmentIndex = (activeSegment as any)?.segmentIndex;
    if (!segmentIndex) {
      return;
    }
    const viewportRepresentations =
      segmentationService.getSegmentationRepresentations?.(viewportId, { segmentationId }) ??
      segmentationService.getSegmentationRepresentations?.(viewportId) ??
      [];
    const viewportRepresentation = viewportRepresentations.find(
      representation => representation.segmentationId === segmentationId
    );
    const color =
      viewportRepresentation?.segments?.[segmentIndex]?.color ||
      segmentationService.getSegmentColor(viewportId, segmentationId, segmentIndex);
    if (!color) {
      return;
    }
    const hexColor = rgbaToHex(color as [number, number, number, number]);

    if (typeof window !== 'undefined') {
      (window as any).__oviActiveManualContourColor = hexColor;
    }

    const isEraseMode =
      typeof window !== 'undefined' && (window as any).__medexManualContourMode === 'erase';
    const strokeColor = isEraseMode ? '#ffffff' : hexColor;

    // Apply the color to all tool groups used by the segmentation mode so that:
    // - stroke color during drawing uses the active segment color (white in erase mode)
    // - fill color after completion uses the active segment color
    const toolGroupIds = ToolGroupManager.getAllToolGroups?.()
      ?.map(toolGroup => toolGroup.id)
      ?.filter(Boolean) ?? ['default', 'mpr', 'volume3d'];

    toolGroupIds.forEach(toolGroupId => {
      const toolGroupStyles = annotation.config.style.getToolGroupToolStyles(toolGroupId) || {};
      const toolSpecificStyles = toolGroupStyles[TOOL_NAME] || {};
      annotation.config.style.setToolGroupToolStyles(toolGroupId, {
        ...toolGroupStyles,
        [TOOL_NAME]: {
          ...toolSpecificStyles,
          color: strokeColor,
          colorHighlighted: strokeColor,
          colorSelected: strokeColor,
          fillColor: strokeColor,
          fillOpacity: FILL_OPACITY,
          renderFill: true,
        },
      });
    });
  } catch {
    // Color sync is best-effort — don't crash if segmentation state is not yet ready
  }
};
