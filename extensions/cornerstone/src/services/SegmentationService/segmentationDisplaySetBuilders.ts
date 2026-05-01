import {
  Enums as csEnums,
  geometryLoader,
  Types as csTypes,
  metaData,
} from '@cornerstonejs/core';
import { Types as cstTypes } from '@cornerstonejs/tools';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';
import { mapROIContoursToRTStructData } from './RTSTRUCT/mapROIContoursToRTStructData';

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
const CONTOUR = csToolsEnums.SegmentationRepresentations.Contour;

export type SEGBuildResult = {
  segmentationId: string;
  imageIds: string[];
  derivedImageIds: string[];
  segments: { [segmentIndex: string]: cstTypes.Segment };
  colorLUT: number[][];
  label: string;
};

export type RTBuildResult = {
  segmentationId: string;
  geometryIds: string[];
  segments: { [segmentIndex: string]: cstTypes.Segment };
  colorLUT: number[][];
  label: string;
};

export function buildSEGSegmentationData(
  segDisplaySet: any,
  displaySetService: any,
  segmentationId?: string
): SEGBuildResult {
  const { labelMapImages } = segDisplaySet;

  if (!labelMapImages || !labelMapImages.length) {
    throw new Error('SEG reading failed');
  }

  const resolvedId = segmentationId ?? segDisplaySet.displaySetInstanceUID;
  const referencedDisplaySet = displaySetService.getDisplaySetByUID(
    segDisplaySet.referencedDisplaySetInstanceUID
  );

  const images = referencedDisplaySet.instances;
  if (!images.length) {
    throw new Error('No instances were provided for the referenced display set of the SEG');
  }

  const imageIds = images.map((image: any) => image.imageId);
  const derivedImages = labelMapImages?.flat();
  const derivedImageIds = derivedImages.map((image: any) => image.imageId);

  segDisplaySet.images = derivedImages.map((image: any) => ({
    ...image,
    ...metaData.get('instance', image.referencedImageId),
  }));
  segDisplaySet.imageIds = derivedImageIds;

  let firstSegmentedSliceImageId = null;
  for (let i = 0; i < derivedImages.length; i++) {
    const voxelManager = derivedImages[i].voxelManager as csTypes.IVoxelManager<number>;
    const scalarData = voxelManager.getScalarData();
    voxelManager.setScalarData(scalarData);

    if (!firstSegmentedSliceImageId && scalarData.some((value: number) => value !== 0)) {
      firstSegmentedSliceImageId = derivedImages[i].referencedImageId;
    }
  }
  segDisplaySet.firstSegmentedSliceImageId = firstSegmentedSliceImageId;

  const segmentsInfo = segDisplaySet.segMetadata.data;
  const segments: { [segmentIndex: string]: cstTypes.Segment } = {};
  const colorLUT: number[][] = [];

  segmentsInfo.forEach((segmentInfo: any, index: number) => {
    if (index === 0) {
      colorLUT.push([0, 0, 0, 0]);
      return;
    }

    const {
      SegmentedPropertyCategoryCodeSequence,
      SegmentNumber,
      SegmentLabel,
      SegmentAlgorithmType,
      SegmentAlgorithmName,
      SegmentedPropertyTypeCodeSequence,
      rgba,
    } = segmentInfo;

    colorLUT.push(rgba);
    const segmentIndex = Number(SegmentNumber);
    const centroid = segDisplaySet.centroids?.get(index);
    const imageCentroidXYZ = centroid?.image || { x: 0, y: 0, z: 0 };
    const worldCentroidXYZ = centroid?.world || { x: 0, y: 0, z: 0 };

    segments[segmentIndex] = {
      segmentIndex,
      label: SegmentLabel || `Segment ${SegmentNumber}`,
      locked: false,
      active: false,
      cachedStats: {
        center: {
          image: [imageCentroidXYZ.x, imageCentroidXYZ.y, imageCentroidXYZ.z],
          world: [worldCentroidXYZ.x, worldCentroidXYZ.y, worldCentroidXYZ.z],
        },
        modifiedTime: segDisplaySet.SeriesDate,
        category: SegmentedPropertyCategoryCodeSequence
          ? SegmentedPropertyCategoryCodeSequence.CodeMeaning
          : '',
        type: SegmentedPropertyTypeCodeSequence
          ? SegmentedPropertyTypeCodeSequence.CodeMeaning
          : '',
        algorithmType: SegmentAlgorithmType,
        algorithmName: SegmentAlgorithmName,
      },
    };
  });

  return {
    segmentationId: resolvedId,
    imageIds,
    derivedImageIds,
    segments,
    colorLUT,
    label: segDisplaySet.SeriesDescription,
  };
}

export async function buildRTSegmentationData(
  rtDisplaySet: any,
  displaySetService: any,
  onSegmentProgress: (data: { percentComplete: number; numSegments: number }) => void,
  segmentationId?: string
): Promise<RTBuildResult> {
  const resolvedId = segmentationId ?? rtDisplaySet.displaySetInstanceUID;
  const { structureSet } = rtDisplaySet;

  if (!structureSet) {
    throw new Error(
      'To create the contours from RT displaySet, the displaySet should be loaded first. You can perform rtDisplaySet.load() before calling this method.'
    );
  }

  const rtDisplaySetUID = rtDisplaySet.displaySetInstanceUID;
  const referencedDisplaySet = displaySetService.getDisplaySetByUID(
    rtDisplaySet.referencedDisplaySetInstanceUID
  );

  const referencedImageIdsWithGeometry = Array.from(structureSet.ReferencedSOPInstanceUIDsSet);
  const referencedImageIds = referencedDisplaySet.imageIds;
  const firstSegmentedSliceImageId =
    referencedImageIds?.find((imageId: string) =>
      referencedImageIdsWithGeometry.some((refId: unknown) => imageId.includes(refId as string))
    ) || null;

  rtDisplaySet.firstSegmentedSliceImageId = firstSegmentedSliceImageId;

  const allRTStructData = mapROIContoursToRTStructData(structureSet, rtDisplaySetUID);
  allRTStructData.sort((a: any, b: any) => a.segmentIndex - b.segmentIndex);

  const geometryIds = allRTStructData.map(({ geometryId }: any) => geometryId);

  if (!structureSet.ROIContours?.length) {
    throw new Error(
      'The structureSet does not contain any ROIContours. Please ensure the structureSet is loaded first.'
    );
  }

  const segments: { [segmentIndex: string]: cstTypes.Segment } = {};
  const colorLUT: number[][] = [[0, 0, 0, 0]];

  for (const rtStructData of allRTStructData) {
    const { data, id, color, segmentIndex, geometryId } = rtStructData;
    colorLUT.push(color);

    try {
      const geometry = await geometryLoader.createAndCacheGeometry(geometryId, {
        geometryData: {
          data,
          id,
          color,
          frameOfReferenceUID: structureSet.frameOfReferenceUID,
          segmentIndex,
        },
        type: csEnums.GeometryType.CONTOUR,
      });

      const contourSet = geometry.data as csTypes.IContourSet;
      const centroid = contourSet.centroid;

      segments[segmentIndex] = {
        label: id,
        segmentIndex,
        cachedStats: {
          center: { world: centroid },
          modifiedTime: rtDisplaySet.SeriesDate,
        },
        locked: false,
        active: false,
      };

      onSegmentProgress({
        percentComplete: Math.round((Object.keys(segments).length / allRTStructData.length) * 100),
        numSegments: allRTStructData.length,
      });
    } catch (e) {
      console.warn(`Error initializing contour for segment ${segmentIndex}:`, e);
    }
  }

  return {
    segmentationId: resolvedId,
    geometryIds,
    segments,
    colorLUT,
    label: rtDisplaySet.SeriesDescription,
  };
}
