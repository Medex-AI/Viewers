import {
  segmentation as cstSegmentation,
  Types as cstTypes,
} from '@cornerstonejs/tools';
import { Types as csTypes } from '@cornerstonejs/core';

export type SegmentRepresentation = {
  segmentIndex: number;
  color: csTypes.Color;
  opacity: number;
  visible: boolean;
};

export type SegmentationRepresentation = cstTypes.SegmentationRepresentation & {
  viewportId: string;
  id: string;
  label: string;
  styles: cstTypes.RepresentationStyle;
  segments: {
    [key: number]: SegmentRepresentation;
  };
};

export function toOHIFSegmentationRepresentation(
  viewportId: string,
  csRepresentation: cstTypes.SegmentationRepresentation
): SegmentationRepresentation {
  const { segmentationId, type, active, visible } = csRepresentation;
  const { colorLUTIndex } = csRepresentation;

  const segmentsRepresentations: { [segmentIndex: number]: SegmentRepresentation } = {};

  const segmentation = cstSegmentation.state.getSegmentation(segmentationId);

  if (!segmentation) {
    throw new Error(`Segmentation with ID ${segmentationId} not found.`);
  }

  const segmentIds = Object.keys(segmentation.segments);

  for (const segmentId of segmentIds) {
    const segmentIndex = parseInt(segmentId, 10);

    const color = cstSegmentation.config.color.getSegmentIndexColor(
      viewportId,
      segmentationId,
      segmentIndex
    );

    const isVisible = cstSegmentation.config.visibility.getSegmentIndexVisibility(
      viewportId,
      {
        segmentationId,
        type,
      },
      segmentIndex
    );

    segmentsRepresentations[segmentIndex] = {
      color,
      segmentIndex,
      opacity: color[3],
      visible: isVisible,
    };
  }

  const styles = cstSegmentation.config.style.getStyle({
    viewportId,
    segmentationId,
    type,
  });

  const id = `${segmentationId}-${type}-${viewportId}`;

  return {
    id,
    segmentationId,
    label: segmentation.label,
    active,
    type,
    visible,
    segments: segmentsRepresentations,
    styles,
    viewportId,
    colorLUTIndex,
    config: {},
  };
}
