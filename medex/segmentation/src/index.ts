import { Types } from '@ohif/core';

const MedExSegmentationExtension: Types.Extensions.Extension = {
  id: '@medex/segmentation',
};

export default MedExSegmentationExtension;
export * from './utils/rasterizeContour';
export * from './utils/colorUtils';
export * from './utils/writeContourToLabelmap';
export * from './utils/sliceIdentityResolver';
