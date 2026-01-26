import { ProbeTool, utilities, annotation } from '@cornerstonejs/tools';
import { getEnabledElement, metaData } from '@cornerstonejs/core';

/**
 * Debug Probe Tool
 *
 * Extends ProbeTool to show world coordinates, pixel coordinates, and intensity.
 * Useful for debugging coordinate transformations.
 */
class DebugProbeTool extends ProbeTool {
  static toolName = 'DebugProbe';

  private _lastViewport: any = null;

  constructor(toolProps = {}, defaultToolProps = {}) {
    super(toolProps, defaultToolProps);

    // Override the getTextLines configuration to show debug info
    this.configuration.getTextLines = (data, targetId) => this._getDebugTextLines(data, targetId);

    // Override renderAnnotation to capture viewport
    const baseRenderAnnotation = this.renderAnnotation.bind(this);
    this.renderAnnotation = (enabledElement, svgDrawingHelper) => {
      this._lastViewport = enabledElement.viewport;
      return baseRenderAnnotation(enabledElement, svgDrawingHelper);
    };
  }

  _getDebugTextLines(data, targetId) {
    const textLines: string[] = [];

    const { cachedStats } = data;
    const { handles } = data;

    if (!handles?.points?.[0]) {
      return textLines;
    }

    const worldPoint = handles.points[0];

    // Get the value/intensity from cached stats
    if (cachedStats && cachedStats[targetId]) {
      const { value, modalityUnit } = cachedStats[targetId];
      if (value !== undefined) {
        const unit = modalityUnit || 'HU';
        textLines.push(`I: ${utilities.roundNumber(value, 2)} ${unit}`);
      }
    }

    // World coordinates (mm)
    textLines.push(`W: ${worldPoint[0].toFixed(2)}, ${worldPoint[1].toFixed(2)}, ${worldPoint[2].toFixed(2)}`);

    // Get pixel/index coordinates using the viewport
    if (this._lastViewport) {
      const viewport = this._lastViewport;

      // Try to get index/pixel coordinates using worldToIndex
      if (viewport.worldToIndex) {
        try {
          const indexPoint = viewport.worldToIndex(worldPoint);
          textLines.push(`P: ${indexPoint[0].toFixed(1)}, ${indexPoint[1].toFixed(1)}`);
        } catch (e) {
          // Fallback to canvas coordinates
          const canvasPoint = viewport.worldToCanvas(worldPoint);
          textLines.push(`C: ${canvasPoint[0].toFixed(1)}, ${canvasPoint[1].toFixed(1)}`);
        }
      } else {
        // Fallback: compute from DICOM metadata
        const imageId = viewport.getCurrentImageId?.();
        if (imageId) {
          const imagePlane = metaData.get('imagePlaneModule', imageId);
          if (imagePlane) {
            const { imageOrientationPatient, imagePositionPatient, rowPixelSpacing, columnPixelSpacing } = imagePlane;
            if (imageOrientationPatient && imagePositionPatient) {
              const rowCos = imageOrientationPatient.slice(0, 3);
              const colCos = imageOrientationPatient.slice(3, 6);
              const position = imagePositionPatient;
              const rowSpacing = rowPixelSpacing || 1;
              const colSpacing = columnPixelSpacing || 1;

              const dx = worldPoint[0] - position[0];
              const dy = worldPoint[1] - position[1];
              const dz = worldPoint[2] - position[2];

              // column index = projection onto colCos / colSpacing
              // row index = projection onto rowCos / rowSpacing
              const col = (dx * colCos[0] + dy * colCos[1] + dz * colCos[2]) / colSpacing;
              const row = (dx * rowCos[0] + dy * rowCos[1] + dz * rowCos[2]) / rowSpacing;

              textLines.push(`P: ${col.toFixed(1)}, ${row.toFixed(1)}`);
            }
          }
        }
      }
    }

    return textLines;
  }
}

export default DebugProbeTool;
