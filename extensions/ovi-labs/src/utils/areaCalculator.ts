import { RoiSegmentationFrame } from './roiSegmentationStore';

export interface LabelAreaResult {
  labelId: string;
  area: number;
  unit: 'mm2' | 'px2';
}

export const calculateLabelAreas = (frame: RoiSegmentationFrame): LabelAreaResult[] => {
  const { maskData, labelMap, width, height, roiWidthWorld, roiHeightWorld } = frame;
  if (!maskData || !labelMap) {
    return [];
  }

  const counts: Record<number, number> = {};
  for (let i = 0; i < maskData.length; i += 1) {
    const labelIndex = maskData[i];
    if (!labelIndex) {
      continue;
    }
    counts[labelIndex] = (counts[labelIndex] || 0) + 1;
  }

  const hasWorldSize =
    typeof roiWidthWorld === 'number' &&
    typeof roiHeightWorld === 'number' &&
    roiWidthWorld > 0 &&
    roiHeightWorld > 0 &&
    width > 0 &&
    height > 0;

  const pixelArea = hasWorldSize ? (roiWidthWorld / width) * (roiHeightWorld / height) : 1;
  const unit: 'mm2' | 'px2' = hasWorldSize ? 'mm2' : 'px2';

  return Object.entries(labelMap).flatMap(([indexString, labelInfo]) => {
    const index = Number(indexString);
    const count = counts[index];
    if (!count || !labelInfo?.labelId) {
      return [];
    }
    return [{
      labelId: labelInfo.labelId,
      area: count * pixelArea,
      unit,
    }];
  });
};
