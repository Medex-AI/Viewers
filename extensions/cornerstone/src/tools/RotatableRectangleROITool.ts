import { RectangleROITool } from '@cornerstonejs/tools';

/**
 * Rotatable Rectangle ROI Tool
 *
 * Extends the standard RectangleROITool with a different name.
 * This is a minimal implementation that just renames the tool.
 */
class RotatableRectangleROITool extends RectangleROITool {
  static toolName = 'RotatableRectangleROI';
}

export default RotatableRectangleROITool;
