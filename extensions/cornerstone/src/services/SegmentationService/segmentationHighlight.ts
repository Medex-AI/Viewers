import {
  Enums as csToolsEnums,
  segmentation as cstSegmentation,
  Types as cstTypes,
} from '@cornerstonejs/tools';
import { easeInOutBell, easeInOutBellRelative } from '../../utils/transitions';
import { ContourStyle, LabelmapStyle } from '@cornerstonejs/tools/types';
import { Segment } from '@cornerstonejs/tools/types/SegmentationStateTypes';

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
const CONTOUR = csToolsEnums.SegmentationRepresentations.Contour;

export function highlightLabelmap(
  segmentIndex: number,
  alpha: number,
  hideOthers: boolean,
  segments: Segment[],
  viewportId: string,
  animationLength: number,
  representation: cstTypes.SegmentationRepresentation
): void {
  const { segmentationId } = representation;
  const newSegmentSpecificConfig: Record<string, any> = {
    fillAlpha: alpha,
  };

  if (hideOthers) {
    throw new Error('hideOthers is not working right now');
    for (let i = 0; i < segments.length; i++) {
      if (i !== segmentIndex) {
        newSegmentSpecificConfig[i] = {
          fillAlpha: 0,
        };
      }
    }
  }

  const { fillAlpha } = cstSegmentation.config.style.getStyle({
    viewportId,
    segmentationId,
    type: LABELMAP,
    segmentIndex,
  }) as LabelmapStyle;

  let startTime: number = null;
  const animation = (timestamp: number) => {
    if (startTime === null) {
      startTime = timestamp;
    }

    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / animationLength, 1);

    cstSegmentation.config.style.setStyle(
      {
        segmentationId,
        segmentIndex,
        type: LABELMAP,
      },
      {
        fillAlpha: easeInOutBell(progress, fillAlpha),
      }
    );

    if (progress < 1) {
      requestAnimationFrame(animation);
    } else {
      cstSegmentation.config.style.setStyle(
        {
          segmentationId,
          segmentIndex,
          type: LABELMAP,
        },
        {}
      );
    }
  };

  requestAnimationFrame(animation);
}

export function highlightContour(
  segmentIndex: number,
  alpha: number,
  hideOthers: boolean,
  segments: Segment[],
  viewportId: string,
  animationLength: number,
  representation: cstTypes.SegmentationRepresentation
): void {
  const { segmentationId } = representation;
  const startTime = performance.now();

  const prevStyle = cstSegmentation.config.style.getStyle({
    type: CONTOUR,
  }) as ContourStyle;

  const prevOutlineWidth = prevStyle.outlineWidth;
  const baseline = Math.max(prevOutlineWidth * 3.5, 5);

  const animate = (currentTime: number) => {
    const progress = (currentTime - startTime) / animationLength;
    if (progress >= 1) {
      cstSegmentation.config.style.resetToGlobalStyle();
      return;
    }

    const reversedProgress = easeInOutBellRelative(progress, baseline, prevOutlineWidth);

    cstSegmentation.config.style.setStyle(
      {
        segmentationId,
        segmentIndex,
        type: CONTOUR,
      },
      {
        outlineWidth: reversedProgress,
      }
    );

    requestAnimationFrame(animate);
  };

  requestAnimationFrame(animate);
}
