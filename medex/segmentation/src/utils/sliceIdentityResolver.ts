import { cache } from '@cornerstonejs/core';
import { Enums as toolEnums, segmentation as cstSegmentation } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';

type SliceIdentityServices = {
  cornerstoneViewportService: any;
  viewportGridService: any;
  displaySetService: any;
};

export type SliceIdentity = {
  frameKey: string | undefined;
  displaySetIndex: number;
  k: number;
  timePointIndex: number;
};

function getFrameNumberFromImageId(imageId?: string): number {
  if (!imageId) {
    return 1;
  }

  const framePathMatch = imageId.match(/\/frames\/(\d+)(?:[/?#]|$)/i);
  if (framePathMatch) {
    return Number.parseInt(framePathMatch[1], 10);
  }

  const frameQueryMatch = imageId.match(/[?&]frame(?:Number)?=(\d+)(?:[&#]|$)/i);
  if (frameQueryMatch) {
    return Number.parseInt(frameQueryMatch[1], 10);
  }

  const instance = DicomMetadataStore.getInstanceByImageId(imageId);
  const instanceFrameNumber = Number(instance?.frameNumber ?? instance?.FrameNumber);
  return Number.isFinite(instanceFrameNumber) && instanceFrameNumber > 0 ? instanceFrameNumber : 1;
}

function stableKey(imageId?: string): string | undefined {
  if (!imageId) {
    return undefined;
  }

  const instance = DicomMetadataStore.getInstanceByImageId(imageId);
  const studyInstanceUID = instance?.StudyInstanceUID;
  const seriesInstanceUID = instance?.SeriesInstanceUID;
  const sopInstanceUID = instance?.SOPInstanceUID;
  const frameNumber = getFrameNumberFromImageId(imageId);

  if (studyInstanceUID && seriesInstanceUID && sopInstanceUID) {
    return `wadors:/dicom-web/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/${frameNumber}`;
  }

  return imageId;
}

function frameKeyMatches(imageId: string | undefined, frameKey: string | undefined): boolean {
  if (!imageId || !frameKey) {
    return false;
  }

  return (stableKey(imageId) || imageId) === frameKey;
}

function getDisplaySetIndex(
  viewportId: string,
  services: SliceIdentityServices,
  frameKey?: string
): number {
  if (!frameKey) {
    return -1;
  }

  const gridViewport = services.viewportGridService?.getState?.()?.viewports?.get?.(viewportId);
  const displaySetInstanceUID = gridViewport?.displaySetInstanceUIDs?.[0];
  const displaySet = displaySetInstanceUID
    ? services.displaySetService?.getDisplaySetByUID?.(displaySetInstanceUID)
    : undefined;
  const imageIds =
    displaySet?.imageIds ?? displaySet?.images?.map?.((image: any) => image.imageId) ?? [];

  return imageIds.findIndex((imageId: string) => frameKeyMatches(imageId, frameKey));
}

function getLabelmapSliceIndex(labelmapVolume: any, frameKey?: string): number {
  if (!labelmapVolume || !frameKey) {
    return -1;
  }

  const referencedImageIds = labelmapVolume.referencedImageIds ?? [];
  const referencedIndex = referencedImageIds.findIndex((imageId: string) =>
    frameKeyMatches(imageId, frameKey)
  );
  if (referencedIndex >= 0) {
    return referencedIndex;
  }

  const imageIds = labelmapVolume.imageIds ?? [];
  for (let i = 0; i < imageIds.length; i++) {
    const labelmapImage = cache.getImage(imageIds[i]);
    const referencedImageId = (labelmapImage as any)?.referencedImageId;
    if (frameKeyMatches(referencedImageId, frameKey)) {
      return i;
    }
  }

  return -1;
}

export function resolveSliceIdentity(
  viewportId: string,
  segmentationId: string,
  services: SliceIdentityServices
): SliceIdentity | null {
  const viewport = services.cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
  if (!viewport) {
    return null;
  }

  const currentImageId = viewport.getCurrentImageId?.();
  const frameKey = stableKey(currentImageId);
  const segmentation = cstSegmentation.state.getSegmentation(segmentationId);
  const volumeId = (
    segmentation?.representationData?.[toolEnums.SegmentationRepresentations.Labelmap] as any
  )?.volumeId;
  const labelmapVolume = volumeId ? cache.getVolume(volumeId) : null;
  if (!labelmapVolume) {
    return null;
  }

  return {
    frameKey,
    displaySetIndex: getDisplaySetIndex(viewportId, services, frameKey),
    k: getLabelmapSliceIndex(labelmapVolume, frameKey),
    timePointIndex: 0,
  };
}
