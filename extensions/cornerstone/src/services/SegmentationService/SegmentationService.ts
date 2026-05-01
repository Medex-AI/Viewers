import * as cornerstone from '@cornerstonejs/core';
import {
  cache,
  Enums as csEnums,
  eventTarget,
  getEnabledElementByViewportId,
  imageLoader,
  StackViewport,
  volumeLoader,
  Types as csTypes,
  utilities as csUtils,
  metaData,
} from '@cornerstonejs/core';
import {
  Enums as csToolsEnums,
  segmentation as cstSegmentation,
  Types as cstTypes,
} from '@cornerstonejs/tools';
import { segmentation as csToolsSegmentationUtils } from '@cornerstonejs/tools/utilities';
import { DicomMetadataStore, PubSubService, Types as OHIFTypes } from '@ohif/core';
import i18n from '@ohif/i18n';
import { highlightLabelmap, highlightContour } from './segmentationHighlight';
import {
  buildSEGSegmentationData,
  buildRTSegmentationData,
} from './segmentationDisplaySetBuilders';
import {
  toOHIFSegmentationRepresentation,
  type SegmentRepresentation,
  type SegmentationRepresentation,
} from './segmentationRepresentationMapper';
import { SegmentationRepresentations } from '@cornerstonejs/tools/enums';
import { addColorLUT } from '@cornerstonejs/tools/segmentation/addColorLUT';
import { getNextColorLUTIndex } from '@cornerstonejs/tools/segmentation/getNextColorLUTIndex';
import { Segment } from '@cornerstonejs/tools/types/SegmentationStateTypes';
import { ContourStyle, LabelmapStyle, SurfaceStyle } from '@cornerstonejs/tools/types';
import { ViewportType } from '@cornerstonejs/core/enums';
import { SegmentationPresentation, SegmentationPresentationItem } from '../../types/Presentation';
import { updateLabelmapSegmentationImageReferences } from '@cornerstonejs/tools/segmentation/updateLabelmapSegmentationImageReferences';
import { triggerSegmentationRepresentationModified } from '@cornerstonejs/tools/segmentation/triggerSegmentationEvents';
import { convertStackToVolumeLabelmap } from '@cornerstonejs/tools/segmentation/helpers/convertStackToVolumeLabelmap';
import { getLabelmapImageIds } from '@cornerstonejs/tools/segmentation';

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
const CONTOUR = csToolsEnums.SegmentationRepresentations.Contour;
const { triggerSegmentationRenderBySegmentationId } = csToolsSegmentationUtils;

export type { SegmentRepresentation } from './segmentationRepresentationMapper';
export type { SegmentationRepresentation } from './segmentationRepresentationMapper';

export type SegmentationData = cstTypes.Segmentation;

export type SegmentationInfo = {
  segmentation: SegmentationData;
  representation?: SegmentationRepresentation;
};

const EVENTS = {
  SEGMENTATION_MODIFIED: 'event::segmentation_modified',
  // fired when the segmentation is added
  SEGMENTATION_ADDED: 'event::segmentation_added',
  //
  SEGMENTATION_DATA_MODIFIED: 'event::segmentation_data_modified',
  // fired when the segmentation is removed
  SEGMENTATION_REMOVED: 'event::segmentation_removed',
  //
  // fired when segmentation representation is added
  SEGMENTATION_REPRESENTATION_MODIFIED: 'event::segmentation_representation_modified',
  // fired when segmentation representation is removed
  SEGMENTATION_REPRESENTATION_REMOVED: 'event::segmentation_representation_removed',
  // fired when the active segment/class changes
  ACTIVE_SEGMENT_MODIFIED: 'event::active_segment_modified',
  //
  // LOADING EVENTS
  // fired when the active segment is loaded in SEG or RTSTRUCT
  SEGMENT_LOADING_COMPLETE: 'event::segment_loading_complete',
  // loading completed for all segments
  SEGMENTATION_LOADING_COMPLETE: 'event::segmentation_loading_complete',
};

const VALUE_TYPES = {};

const VOLUME_LOADER_SCHEME = 'cornerstoneStreamingImageVolume';

const getFrameNumberFromImageId = (imageId?: string): number => {
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

  return 1;
};

const getStableFrameKey = (imageId?: string): string | null => {
  if (!imageId) {
    return null;
  }

  const match = imageId.match(
    /\/studies\/([^/]+)\/series\/([^/]+)\/instances\/([^/]+)\/frames\/(\d+)(?:[/?#]|$)/i
  );
  if (match) {
    const [, studyInstanceUID, seriesInstanceUID, sopInstanceUID] = match;
    const frameNumber = getFrameNumberFromImageId(imageId);
    return `wadors:/dicom-web/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/${frameNumber}`;
  }

  return imageId;
};

const tryGetVoxelScalarData = (volumeOrImage: any): Uint8Array | null => {
  try {
    return volumeOrImage?.voxelManager?.getScalarData?.() || null;
  } catch (error) {
    console.warn('[SegmentationService] scalar data unavailable', {
      error,
      volumeId: volumeOrImage?.volumeId,
      imageIds: volumeOrImage?.imageIds?.length || 0,
      hasScalarVolume: volumeOrImage?.hasScalarVolume,
      hasVoxelManager: Boolean(volumeOrImage?.voxelManager),
    });
    return null;
  }
};

const getScalarLengthForImage = (image: any): number => {
  const width = image?.columns ?? image?.width ?? 0;
  const height = image?.rows ?? image?.height ?? 0;
  const numberOfComponents = image?.numberOfComponents ?? 1;
  return width * height * numberOfComponents;
};

const readVolumeScalarDataFromImages = (volume: any): Uint8Array | null => {
  const imageIds = volume?.imageIds ?? [];
  if (!imageIds.length) {
    return null;
  }

  const slices = imageIds.map(imageId => cache.getImage(imageId)).filter(Boolean);

  if (slices.length !== imageIds.length) {
    return null;
  }

  const totalLength = slices.reduce((sum, image) => sum + getScalarLengthForImage(image), 0);
  if (!totalLength) {
    return null;
  }

  const scalarData = new Uint8Array(totalLength);
  let offset = 0;

  for (const image of slices) {
    const sliceScalar = tryGetVoxelScalarData(image);
    if (!sliceScalar) {
      return null;
    }

    scalarData.set(sliceScalar, offset);
    offset += sliceScalar.length;
  }

  return scalarData;
};

const writeVolumeScalarDataToImages = (volume: any, scalarData: Uint8Array): boolean => {
  const imageIds = volume?.imageIds ?? [];
  if (!imageIds.length) {
    return false;
  }

  let offset = 0;

  for (const imageId of imageIds) {
    const image = cache.getImage(imageId);
    if (!image) {
      return false;
    }

    const sliceScalar = tryGetVoxelScalarData(image);
    if (!sliceScalar) {
      return false;
    }

    if (offset + sliceScalar.length > scalarData.length) {
      return false;
    }

    sliceScalar.set(scalarData.subarray(offset, offset + sliceScalar.length));
    offset += sliceScalar.length;
  }

  return offset === scalarData.length;
};

const logDynamicSegmentation = (phase: string, details?: Record<string, unknown>) => {
  void phase;
  void details;
};

const countNonZero = (data?: ArrayLike<number> | null): number => {
  if (!data) return 0;

  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) count++;
  }
  return count;
};

const getSanitizedLabelmapImageIds = (segmentationId: string): string[] => {
  const segmentation = cstSegmentation.state.getSegmentation(segmentationId);
  const labelmapData = segmentation?.representationData?.[SegmentationRepresentations.Labelmap] as
    | { imageIds?: string[]; referencedImageIds?: string[] }
    | undefined;

  const imageIds = labelmapData?.imageIds ?? [];
  const referencedImageIds = labelmapData?.referencedImageIds ?? [];
  const sanitized = imageIds.reduce(
    (acc, imageId, index) => {
      const referencedImageId = referencedImageIds[index];
      if (imageId && referencedImageId) {
        acc.imageIds.push(imageId);
        acc.referencedImageIds.push(referencedImageId);
      }
      return acc;
    },
    { imageIds: [] as string[], referencedImageIds: [] as string[] }
  );

  if (
    labelmapData &&
    (sanitized.imageIds.length !== imageIds.length ||
      sanitized.referencedImageIds.length !== referencedImageIds.length)
  ) {
    labelmapData.imageIds = sanitized.imageIds;
    labelmapData.referencedImageIds = sanitized.referencedImageIds;
  }

  return sanitized.imageIds;
};

const getSanitizedLabelmapReferencedImageIds = (segmentationId: string): string[] => {
  const segmentation = cstSegmentation.state.getSegmentation(segmentationId);
  const labelmapData = segmentation?.representationData?.[SegmentationRepresentations.Labelmap] as
    | { imageIds?: string[]; referencedImageIds?: string[] }
    | undefined;

  const imageIds = labelmapData?.imageIds ?? [];
  const referencedImageIds = labelmapData?.referencedImageIds ?? [];
  const sanitized = imageIds.reduce(
    (acc, imageId, index) => {
      const referencedImageId = referencedImageIds[index];
      if (imageId && referencedImageId) {
        acc.imageIds.push(imageId);
        acc.referencedImageIds.push(referencedImageId);
      }
      return acc;
    },
    { imageIds: [] as string[], referencedImageIds: [] as string[] }
  );

  if (
    labelmapData &&
    (sanitized.imageIds.length !== imageIds.length ||
      sanitized.referencedImageIds.length !== referencedImageIds.length)
  ) {
    labelmapData.imageIds = sanitized.imageIds;
    labelmapData.referencedImageIds = sanitized.referencedImageIds;
  }

  return sanitized.referencedImageIds;
};

const toVector3 = (value: unknown): [number, number, number] | null => {
  if (!value) return null;

  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\\')
      : null;

  if (!values || values.length < 3) return null;

  const vector = values.slice(0, 3).map(Number);
  return vector.every(Number.isFinite) ? (vector as [number, number, number]) : null;
};

const dot = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const getImagePlaneGeometry = (imageId: string) => {
  const imagePlane = metaData.get('imagePlaneModule', imageId) || {};
  const instance = DicomMetadataStore.getInstanceByImageId(imageId) || {};
  const rowCosines =
    toVector3(imagePlane.rowCosines) ||
    toVector3(imagePlane.rowCosine) ||
    toVector3(imagePlane.imageOrientationPatient?.slice?.(0, 3)) ||
    toVector3(instance.ImageOrientationPatient?.slice?.(0, 3));
  const columnCosines =
    toVector3(imagePlane.columnCosines) ||
    toVector3(imagePlane.columnCosine) ||
    toVector3(imagePlane.imageOrientationPatient?.slice?.(3, 6)) ||
    toVector3(instance.ImageOrientationPatient?.slice?.(3, 6));
  const imagePositionPatient =
    toVector3(imagePlane.imagePositionPatient) ||
    toVector3(imagePlane.imagePosition) ||
    toVector3(instance.ImagePositionPatient);

  if (!rowCosines || !columnCosines || !imagePositionPatient) {
    return null;
  }

  return {
    rowCosines,
    columnCosines,
    normal: cross(rowCosines, columnCosines),
    imagePositionPatient,
  };
};

const hasReconstructableImageGeometry = (imageIds: string[]): boolean => {
  if (imageIds.length < 2) {
    return true;
  }

  const geometries = imageIds.map(getImagePlaneGeometry);
  if (geometries.some(geometry => !geometry)) {
    return true;
  }

  const [first] = geometries;
  const orientationTolerance = 0.999;
  const positionTolerance = 0.01;
  const slicePositions = new Set<string>();

  for (const geometry of geometries) {
    if (
      Math.abs(dot(first.rowCosines, geometry.rowCosines)) < orientationTolerance ||
      Math.abs(dot(first.columnCosines, geometry.columnCosines)) < orientationTolerance
    ) {
      return false;
    }

    const slicePosition = dot(geometry.imagePositionPatient, first.normal);
    const positionKey = (Math.round(slicePosition / positionTolerance) * positionTolerance).toFixed(
      2
    );
    if (slicePositions.has(positionKey)) {
      return false;
    }
    slicePositions.add(positionKey);
  }

  return true;
};

class SegmentationService extends PubSubService {
  static REGISTRATION = {
    name: 'segmentationService',
    altName: 'SegmentationService',
    create: ({ servicesManager }: OHIFTypes.Extensions.ExtensionParams): SegmentationService => {
      return new SegmentationService({ servicesManager });
    },
  };

  private _segmentationIdToColorLUTIndexMap: Map<string, number>;
  private _segmentationGroupStatsMap: Map<string, any>;
  private _hasShownCPUFallbackVolumeSegmentationWarning: boolean;
  private _hasShownCPUFallbackBrushWarning: boolean;

  /** Per-timepoint scalar buffer store for 3D+T segmentations. */
  private _dynamicSegmentationMap = new Map<
    string, // segmentationId
    {
      labelmapVolumeId: string;
      dynamicVolumeId: string;
      numTimePoints: number;
      currentTimePoint: number;
      scalarBuffers: Uint8Array[];
      restoredTimePoints?: Set<number>;
      restoreWriteProtectedUntil?: number;
    }
  >();
  private _dynamicVolumeListenerRegistered = false;
  readonly servicesManager: AppTypes.ServicesManager;
  highlightIntervalId = null;
  readonly EVENTS = EVENTS;

  constructor({ servicesManager }) {
    super(EVENTS);

    this._segmentationIdToColorLUTIndexMap = new Map();

    this.servicesManager = servicesManager;

    this._segmentationGroupStatsMap = new Map();
    this._hasShownCPUFallbackVolumeSegmentationWarning = false;
    this._hasShownCPUFallbackBrushWarning = false;
  }

  public onModeEnter(): void {
    this._initSegmentationService();
  }

  public onModeExit(): void {
    this.destroy();
  }

  /**
   * Retrieves a segmentation by its ID.
   *
   * @param segmentationId - The unique identifier of the segmentation to retrieve.
   * @returns The segmentation object if found, or undefined if not found.
   *
   * @remarks
   * This method directly accesses the cornerstone tools segmentation state to fetch
   * the segmentation data. It's useful when you need to access specific properties
   * or perform operations on a particular segmentation.
   */
  public getSegmentation(segmentationId: string): cstTypes.Segmentation | undefined {
    return cstSegmentation.state.getSegmentation(segmentationId);
  }

  /**
   * Retrieves all segmentations from the cornerstone tools segmentation state.
   *
   * @returns An array of all segmentations currently stored in the state
   *
   * @remarks
   * This is a convenience method that directly accesses the cornerstone tools
   * segmentation state to get all available segmentations. It returns the raw
   * segmentation objects without any additional processing or filtering.
   */
  public getSegmentations(): cstTypes.Segmentation[] | [] {
    return cstSegmentation.state.getSegmentations();
  }

  public hasDynamicSegmentation(segmentationId: string): boolean {
    return this._dynamicSegmentationMap.has(segmentationId);
  }

  public getDynamicSegmentationInfo(
    segmentationId: string
  ): { currentTimePoint: number; numTimePoints: number } | null {
    const state = this._dynamicSegmentationMap.get(segmentationId);
    if (!state) {
      return null;
    }

    return {
      currentTimePoint: state.currentTimePoint,
      numTimePoints: state.numTimePoints,
    };
  }

  public syncDynamicSegmentationCurrentTimePoint(segmentationId: string): boolean {
    const state = this._dynamicSegmentationMap.get(segmentationId);
    if (!state) {
      return false;
    }

    const labelmapVolume = cache.getVolume(state.labelmapVolumeId) as any;
    if (!labelmapVolume) {
      return false;
    }

    const activeScalar = readVolumeScalarDataFromImages(labelmapVolume);
    if (!activeScalar) {
      logDynamicSegmentation('syncCurrentTimePoint:no-scalar-data', {
        segmentationId,
        labelmapVolumeId: state.labelmapVolumeId,
        currentTimePoint: state.currentTimePoint,
      });
      return false;
    }
    state.scalarBuffers[state.currentTimePoint].set(activeScalar);
    return true;
  }

  private _clearSegmentFromDynamicBuffers(segmentationId: string, segmentIndex: number): boolean {
    const state = this._dynamicSegmentationMap.get(segmentationId);
    if (!state) {
      return false;
    }

    let cleared = false;
    for (const buffer of state.scalarBuffers) {
      if (!buffer) {
        continue;
      }
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === segmentIndex) {
          buffer[i] = 0;
          cleared = true;
        }
      }
    }

    logDynamicSegmentation('clearSegmentFromDynamicBuffers', {
      segmentationId,
      segmentIndex,
      cleared,
      numTimePoints: state.numTimePoints,
    });

    return cleared;
  }

  private _clearSegmentFromLabelmapData(segmentationId: string, segmentIndex: number): boolean {
    const segmentation = this.getCornerstoneSegmentation(segmentationId) as any;
    const labelmapData = segmentation?.representationData?.[LABELMAP];
    if (!labelmapData) {
      return false;
    }

    let cleared = false;
    const clearScalarData = (data?: ArrayLike<number> | null) => {
      if (!data) {
        return;
      }
      for (let i = 0; i < data.length; i++) {
        if (data[i] === segmentIndex) {
          (data as any)[i] = 0;
          cleared = true;
        }
      }
    };

    for (const imageId of labelmapData.imageIds || []) {
      clearScalarData(cache.getImage(imageId)?.voxelManager?.getScalarData?.());
    }

    if (labelmapData.volumeId) {
      clearScalarData((cache.getVolume(labelmapData.volumeId) as any)?.voxelManager?.getScalarData?.());
    }

    return cleared;
  }

  public restoreDynamicSegmentationCurrentTimePointBuffer(segmentationId: string): boolean {
    const state = this._dynamicSegmentationMap.get(segmentationId);
    if (!state) {
      return false;
    }

    const labelmapVolume = cache.getVolume(state.labelmapVolumeId) as any;
    const currentBuffer = state.scalarBuffers[state.currentTimePoint];
    if (!labelmapVolume || !currentBuffer) {
      logDynamicSegmentation('restoreCurrentTimePointBuffer:skipped', {
        segmentationId,
        hasLabelmapVolume: Boolean(labelmapVolume),
        hasCurrentBuffer: Boolean(currentBuffer),
        currentTimePoint: state.currentTimePoint,
      });
      return false;
    }

    const liveBefore = readVolumeScalarDataFromImages(labelmapVolume);
    logDynamicSegmentation('restoreCurrentTimePointBuffer:before-write', {
      segmentationId,
      labelmapVolumeId: state.labelmapVolumeId,
      currentTimePoint: state.currentTimePoint,
      bufferLength: currentBuffer.length,
      bufferNonZero: countNonZero(currentBuffer),
      liveLength: liveBefore?.length || 0,
      liveNonZero: countNonZero(liveBefore),
    });

    if (!writeVolumeScalarDataToImages(labelmapVolume, currentBuffer)) {
      logDynamicSegmentation('restoreCurrentTimePointBuffer:write-failed', {
        segmentationId,
        labelmapVolumeId: state.labelmapVolumeId,
        currentTimePoint: state.currentTimePoint,
      });
      return false;
    }

    labelmapVolume.invalidate();
    triggerSegmentationRenderBySegmentationId(segmentationId);
    const liveAfter = readVolumeScalarDataFromImages(labelmapVolume);
    logDynamicSegmentation('restoreCurrentTimePointBuffer:done', {
      segmentationId,
      labelmapVolumeId: state.labelmapVolumeId,
      currentTimePoint: state.currentTimePoint,
      liveLength: liveAfter?.length || 0,
      liveNonZero: countNonZero(liveAfter),
    });
    return true;
  }

  public restoreDynamicSegmentationTimePointBuffers(
    segmentationId: string,
    referencedImageIds: string[],
    frameLookup: Map<string, { maskData: Uint8Array }>
  ): number[] {
    const state = this._dynamicSegmentationMap.get(segmentationId);
    if (!state || !referencedImageIds.length || !frameLookup.size) {
      logDynamicSegmentation('restoreTimePointBuffers:skipped', {
        segmentationId,
        hasState: Boolean(state),
        referencedImageCount: referencedImageIds.length,
        frameLookupSize: frameLookup.size,
      });
      return [];
    }

    const labelmapVolume = cache.getVolume(state.labelmapVolumeId) as any;
    if (!labelmapVolume) {
      return [];
    }

    const framesPerTimePoint = referencedImageIds.length / state.numTimePoints;
    if (!Number.isInteger(framesPerTimePoint) || framesPerTimePoint <= 0) {
      return [];
    }

    const activeScalar = readVolumeScalarDataFromImages(labelmapVolume);
    if (!activeScalar) {
      logDynamicSegmentation('restoreTimePointBuffers:no-active-scalar', {
        segmentationId,
        labelmapVolumeId: state.labelmapVolumeId,
      });
      return [];
    }
    const scalarLength = activeScalar.length;
    const modifiedTimePoints = new Set<number>();

    for (let timePointIndex = 0; timePointIndex < state.numTimePoints; timePointIndex += 1) {
      const buffer = state.scalarBuffers[timePointIndex];
      if (!buffer || buffer.length !== scalarLength) {
        continue;
      }

      buffer.fill(0);
      let wroteAnyFrame = false;
      for (let sliceIndex = 0; sliceIndex < framesPerTimePoint; sliceIndex += 1) {
        const referenceIndex = timePointIndex * framesPerTimePoint + sliceIndex;
        const referencedImageId = referencedImageIds[referenceIndex];
        if (!referencedImageId) {
          continue;
        }

        const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
        const frame = frameLookup.get(stableFrameKey) || frameLookup.get(referencedImageId);
        if (!frame) {
          continue;
        }

        const frameOffset = sliceIndex * frame.maskData.length;
        if (frameOffset + frame.maskData.length > buffer.length) {
          continue;
        }

        buffer.set(frame.maskData, frameOffset);
        wroteAnyFrame = true;
      }

      if (wroteAnyFrame) {
        modifiedTimePoints.add(timePointIndex);
      }
    }

    state.restoredTimePoints = new Set(modifiedTimePoints);
    state.restoreWriteProtectedUntil = Date.now() + 3000;

    if (modifiedTimePoints.has(state.currentTimePoint)) {
      logDynamicSegmentation('restoreTimePointBuffers:before-active-write', {
        segmentationId,
        labelmapVolumeId: state.labelmapVolumeId,
        currentTimePoint: state.currentTimePoint,
        bufferLength: state.scalarBuffers[state.currentTimePoint]?.length || 0,
        bufferNonZero: countNonZero(state.scalarBuffers[state.currentTimePoint]),
      });
      if (
        !writeVolumeScalarDataToImages(labelmapVolume, state.scalarBuffers[state.currentTimePoint])
      ) {
        logDynamicSegmentation('restoreTimePointBuffers:write-failed', {
          segmentationId,
          labelmapVolumeId: state.labelmapVolumeId,
          currentTimePoint: state.currentTimePoint,
        });
        return [];
      }
      labelmapVolume.invalidate();
      triggerSegmentationRenderBySegmentationId(segmentationId);
    }

    logDynamicSegmentation('restoreTimePointBuffers:done', {
      segmentationId,
      numTimePoints: state.numTimePoints,
      modifiedTimePoints: Array.from(modifiedTimePoints),
      currentTimePoint: state.currentTimePoint,
      liveNonZero: countNonZero(readVolumeScalarDataFromImages(labelmapVolume)),
    });

    return Array.from(modifiedTimePoints).sort((a, b) => a - b);
  }

  public async getDynamicSegmentationFrameSnapshots(segmentationId: string): Promise<
    Array<{
      referencedImageId: string;
      frameNumber: number;
      width: number;
      height: number;
      maskData: Uint8Array;
    }>
  > {
    const state = this._dynamicSegmentationMap.get(segmentationId);
    const segmentation = this.getSegmentation(segmentationId);
    const labelmapData = segmentation?.representationData?.[
      SegmentationRepresentations.Labelmap
    ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;

    const referencedImageIds = labelmapData?.referencedImageIds ?? [];
    if (!state || !referencedImageIds.length) {
      return [];
    }

    const framesPerTimePoint = referencedImageIds.length / state.numTimePoints;
    if (!Number.isInteger(framesPerTimePoint) || framesPerTimePoint <= 0) {
      return [];
    }

    const sampleImageId = labelmapData?.imageIds?.[0];
    const sampleImage = sampleImageId
      ? cache.getImage(sampleImageId) || (await imageLoader.loadAndCacheImage(sampleImageId))
      : null;
    const width = sampleImage?.columns ?? sampleImage?.width;
    const height = sampleImage?.rows ?? sampleImage?.height;
    if (!width || !height) {
      return [];
    }

    const frameLength = width * height;
    const snapshots: Array<{
      referencedImageId: string;
      frameNumber: number;
      width: number;
      height: number;
      maskData: Uint8Array;
    }> = [];

    this.syncDynamicSegmentationCurrentTimePoint(segmentationId);

    for (let timePointIndex = 0; timePointIndex < state.numTimePoints; timePointIndex += 1) {
      const buffer = state.scalarBuffers[timePointIndex];
      if (!buffer) {
        continue;
      }

      for (let sliceIndex = 0; sliceIndex < framesPerTimePoint; sliceIndex += 1) {
        const referencedIndex = timePointIndex * framesPerTimePoint + sliceIndex;
        const referencedImageId = referencedImageIds[referencedIndex];
        if (!referencedImageId) {
          continue;
        }

        const offset = sliceIndex * frameLength;
        if (offset + frameLength > buffer.length) {
          continue;
        }

        snapshots.push({
          referencedImageId,
          frameNumber: getFrameNumberFromImageId(referencedImageId),
          width,
          height,
          maskData: buffer.slice(offset, offset + frameLength),
        });
      }
    }

    return snapshots;
  }

  public async getDynamicSegmentationCurrentTimePointFrameSnapshots(
    segmentationId: string
  ): Promise<
    Array<{
      referencedImageId: string;
      frameNumber: number;
      width: number;
      height: number;
      maskData: Uint8Array;
    }>
  > {
    const state = this._dynamicSegmentationMap.get(segmentationId);
    const segmentation = this.getSegmentation(segmentationId);
    const labelmapData = segmentation?.representationData?.[
      SegmentationRepresentations.Labelmap
    ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;

    const referencedImageIds = labelmapData?.referencedImageIds ?? [];
    if (!state || !referencedImageIds.length) {
      return [];
    }

    const framesPerTimePoint = referencedImageIds.length / state.numTimePoints;
    if (!Number.isInteger(framesPerTimePoint) || framesPerTimePoint <= 0) {
      return [];
    }

    const sampleImageId = labelmapData?.imageIds?.[0];
    const sampleImage = sampleImageId
      ? cache.getImage(sampleImageId) || (await imageLoader.loadAndCacheImage(sampleImageId))
      : null;
    const width = sampleImage?.columns ?? sampleImage?.width;
    const height = sampleImage?.rows ?? sampleImage?.height;
    if (!width || !height) {
      return [];
    }

    const frameLength = width * height;
    this.syncDynamicSegmentationCurrentTimePoint(segmentationId);

    const buffer = state.scalarBuffers[state.currentTimePoint];
    if (!buffer) {
      return [];
    }

    const snapshots: Array<{
      referencedImageId: string;
      frameNumber: number;
      width: number;
      height: number;
      maskData: Uint8Array;
    }> = [];

    for (let sliceIndex = 0; sliceIndex < framesPerTimePoint; sliceIndex += 1) {
      const referencedIndex = state.currentTimePoint * framesPerTimePoint + sliceIndex;
      const referencedImageId = referencedImageIds[referencedIndex];
      if (!referencedImageId) {
        continue;
      }

      const offset = sliceIndex * frameLength;
      if (offset + frameLength > buffer.length) {
        continue;
      }

      snapshots.push({
        referencedImageId,
        frameNumber: getFrameNumberFromImageId(referencedImageId),
        width,
        height,
        maskData: buffer.slice(offset, offset + frameLength),
      });
    }

    return snapshots;
  }

  public getPresentation(viewportId: string): SegmentationPresentation {
    const segmentationPresentations: SegmentationPresentation = [];
    const segmentationsMap = new Map<string, SegmentationPresentationItem>();

    const representations = this.getSegmentationRepresentations(viewportId);
    for (const representation of representations) {
      const { segmentationId } = representation;

      if (!representation) {
        continue;
      }

      const { type } = representation;

      segmentationsMap.set(segmentationId, {
        segmentationId,
        type,
        hydrated: true,
        config: representation.config || {},
      });
    }

    // Check inside the removedDisplaySetAndRepresentationMaps to see if any of the representations are not hydrated
    // const hydrationMap = this._segmentationRepresentationHydrationMaps.get(presentationId);

    // if (hydrationMap) {
    //   hydrationMap.forEach(rep => {
    //     segmentationsMap.set(rep.segmentationId, {
    //       segmentationId: rep.segmentationId,
    //       type: rep.type,
    //       hydrated: rep.hydrated,
    //       config: rep.config || {},
    //     });
    //   });
    // }

    // // Convert the Map to an array
    segmentationPresentations.push(...segmentationsMap.values());

    return segmentationPresentations;
  }

  public getRepresentationsForSegmentation(
    segmentationId: string
  ): { viewportId: string; representations: any[] }[] {
    const representations =
      cstSegmentation.state.getSegmentationRepresentationsBySegmentationId(segmentationId);

    return representations;
  }

  /**
   * Retrieves segmentation representations (labelmap, contour, surface) based on specified criteria.
   *
   * @param viewportId - The ID of the viewport.
   * @param specifier - An object containing optional `segmentationId` and `type` to filter the representations.
   * @returns An array of `SegmentationRepresentation` matching the criteria, or an empty array if none are found.
   *
   * @remarks
   * This method filters the segmentation representations according to the provided `specifier`:
   * - **No `segmentationId` or `type` provided**: Returns all representations associated with the given `viewportId`.
   * - **Only `segmentationId` provided**: Returns all representations with that `segmentationId`, regardless of `viewportId`.
   * - **Only `type` provided**: Returns all representations of that `type` associated with the given `viewportId`.
   * - **Both `segmentationId` and `type` provided**: Returns representations matching both criteria, regardless of `viewportId`.
   */
  public getSegmentationRepresentations(
    viewportId: string,
    specifier: {
      segmentationId?: string;
      type?: SegmentationRepresentations;
    } = {}
  ): SegmentationRepresentation[] {
    // Get all representations for the viewportId
    const representations = cstSegmentation.state.getSegmentationRepresentations(
      viewportId,
      specifier
    );

    // Map to our SegmentationRepresentation type
    const ohifRepresentations = representations.map(repr =>
      this._toOHIFSegmentationRepresentation(viewportId, repr)
    );

    return ohifRepresentations;
  }

  public destroy = () => {
    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_MODIFIED,
      this._onSegmentationModifiedFromSource
    );

    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_REMOVED,
      this._onSegmentationModifiedFromSource
    );

    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED,
      this._onSegmentationDataModifiedFromSource
    );

    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_REPRESENTATION_ADDED,
      this._onSegmentationModifiedFromSource
    );

    eventTarget.removeEventListener(
      csToolsEnums.Events.SEGMENTATION_ADDED,
      this._onSegmentationAddedFromSource
    );

    this.listeners = {};
  };

  public async addSegmentationRepresentation(
    viewportId: string,
    {
      segmentationId,
      type,
      config,
      suppressEvents = false,
    }: {
      segmentationId: string;
      type?: csToolsEnums.SegmentationRepresentations;
      config?: {
        blendMode?: csEnums.BlendModes;
      };
      suppressEvents?: boolean;
    }
  ): Promise<void> {
    const segmentation = this.getSegmentation(segmentationId);
    const csViewport = this.getAndValidateViewport(viewportId);

    if (!csViewport) {
      return;
    }

    const colorLUTIndex = this._segmentationIdToColorLUTIndexMap.get(segmentationId);

    const defaultRepresentationType = csToolsEnums.SegmentationRepresentations.Labelmap;
    let representationTypeToUse = type || defaultRepresentationType;
    let isConverted = false;
    let shouldAddRepresentation = true;

    if (type === csToolsEnums.SegmentationRepresentations.Labelmap) {
      const { isVolumeViewport, isVolumeSegmentation } = this.determineViewportAndSegmentationType(
        csViewport,
        segmentation
      );

      ({ representationTypeToUse, isConverted, shouldAddRepresentation } =
        await this.handleViewportConversion(
          isVolumeViewport,
          isVolumeSegmentation,
          csViewport,
          segmentation,
          viewportId,
          segmentationId,
          representationTypeToUse
        ));
    }

    if (!shouldAddRepresentation) {
      return;
    }

    await this._addSegmentationRepresentation(
      viewportId,
      segmentationId,
      representationTypeToUse,
      colorLUTIndex,
      isConverted,
      config
    );

    if (csViewport instanceof StackViewport && representationTypeToUse === LABELMAP) {
      try {
        (
          (cstSegmentation as any).state?.getStackSegmentationImageIdsForViewport ||
          (cstSegmentation as any).getStackSegmentationImageIdsForViewport
        )?.(viewportId, segmentationId);
      } catch (error) {
        console.debug('[SegmentationService] stack labelmap precompute failed', {
          viewportId,
          segmentationId,
          error,
        });
      }
    }

    if (!suppressEvents) {
      this._broadcastEvent(this.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED, { segmentationId });
    }
  }

  /**
   * Creates an labelmap segmentation for a given display set
   *
   * @param displaySet - The display set to create the segmentation for.
   * @param options - Optional parameters for creating the segmentation.
   * @param options.segmentationId - Custom segmentation ID. If not provided, a UUID will be generated.
   * @param options.FrameOfReferenceUID - Frame of reference UID for the segmentation.
   * @param options.label - Label for the segmentation.
   * @returns A promise that resolves to the created segmentation ID.
   */
  public async createLabelmapForDisplaySet(
    displaySet: AppTypes.DisplaySet,
    options?: {
      segmentationId?: string;
      segments?: { [segmentIndex: number]: Partial<cstTypes.Segment> };
      FrameOfReferenceUID?: string;
      label?: string;
    }
  ): Promise<string> {
    // Todo: random does not makes sense, make this better, like
    // labelmap 1, 2, 3 etc
    const segmentationId = options?.segmentationId ?? `${csUtils.uuidv4()}`;

    const isDynamicVolume = displaySet.isDynamicVolume;

    let referenceImageIds = displaySet.imageIds;
    if (isDynamicVolume) {
      // For dynamic (3D+T) volumes, create labelmap images covering ALL timepoints.
      // CornerstoneJS matches labelmaps to source images by referencedImageId, so
      // registering all timepoint images in one segmentation causes the correct
      // per-timepoint labelmap to be displayed automatically as the cine player
      // advances — no explicit timepoint-swap event handling required.
      // Fall back to displaySet.imageIds (which is already the full flat list)
      // if dynamicVolumeInfo is absent on some 3D+T datasets (e.g. ACDC cardiac).
      const timePoints = displaySet.dynamicVolumeInfo?.timePoints;
      if (timePoints?.length) {
        referenceImageIds = timePoints.flat();
      }
    }

    const derivedImages = await imageLoader.createAndCacheDerivedLabelmapImages(referenceImageIds);

    const segs = this.getSegmentations();
    const label = options.label || `Segmentation ${segs.length + 1}`;

    const segImageIds = derivedImages.map(image => image.imageId);

    const segmentationPublicInput: cstTypes.SegmentationPublicInput = {
      segmentationId,
      representation: {
        type: LABELMAP,
        data: {
          imageIds: segImageIds,
          // referencedVolumeId: this._getVolumeIdForDisplaySet(displaySet),
          referencedImageIds: referenceImageIds,
        },
      },
      config: {
        label,
        segments:
          options?.segments !== undefined
            ? options.segments
            : {
                1: {
                  label: `${i18n.t('Segment')} 1`,
                  active: true,
                },
              },
        cachedStats: {
          info: `S${displaySet.SeriesNumber}: ${displaySet.SeriesDescription}`,
        },
      },
    };

    this.addOrUpdateSegmentation(segmentationPublicInput);
    return segmentationId;
  }

  public async createSegmentationForSEGDisplaySet(
    segDisplaySet,
    options: {
      segmentationId?: string;
      type: SegmentationRepresentations;
    } = {
      type: LABELMAP,
    }
  ): Promise<string> {
    const { type } = options;

    if (type !== LABELMAP) {
      throw new Error('Only labelmap type is supported for SEG display sets right now');
    }

    const { displaySetService } = this.servicesManager.services;
    const { segmentationId, imageIds, derivedImageIds, segments, colorLUT, label } =
      buildSEGSegmentationData(segDisplaySet, displaySetService, options.segmentationId);

    const colorLUTIndex = getNextColorLUTIndex();
    addColorLUT(colorLUT, colorLUTIndex);
    this._segmentationIdToColorLUTIndexMap.set(segmentationId, colorLUTIndex);

    this._broadcastEvent(EVENTS.SEGMENTATION_LOADING_COMPLETE, { segmentationId, segDisplaySet });

    const seg: cstTypes.SegmentationPublicInput = {
      segmentationId,
      representation: {
        type: LABELMAP,
        data: { imageIds: derivedImageIds, referencedImageIds: imageIds as string[] },
      },
      config: { label, segments },
    };

    segDisplaySet.isLoaded = true;
    this.addOrUpdateSegmentation(seg);
    return segmentationId;
  }

  public async createSegmentationForRTDisplaySet(
    rtDisplaySet,
    options: {
      segmentationId?: string;
      type: SegmentationRepresentations;
    } = {
      type: CONTOUR,
    }
  ): Promise<string> {
    const { type } = options;

    if (type !== CONTOUR) {
      throw new Error('Only contour type is supported for RT display sets right now');
    }

    const { displaySetService } = this.servicesManager.services;
    const { segmentationId, geometryIds, segments, colorLUT, label } =
      await buildRTSegmentationData(
        rtDisplaySet,
        displaySetService,
        data => this._broadcastEvent(EVENTS.SEGMENT_LOADING_COMPLETE, data),
        options.segmentationId
      );

    const colorLUTIndex = getNextColorLUTIndex();
    addColorLUT(colorLUT, colorLUTIndex);
    this._segmentationIdToColorLUTIndexMap.set(segmentationId, colorLUTIndex);

    const segmentation: cstTypes.SegmentationPublicInput = {
      segmentationId,
      representation: { type: CONTOUR, data: { geometryIds } },
      config: { label, segments },
    };

    this._broadcastEvent(EVENTS.SEGMENTATION_LOADING_COMPLETE, { segmentationId, rtDisplaySet });
    rtDisplaySet.isLoaded = true;
    this.addOrUpdateSegmentation(segmentation);
    return segmentationId;
  }

  /**
   * Adds or updates a segmentation in the state
   * @param segmentationId - The ID of the segmentation to add or update
   * @param data - The data to add or update the segmentation with
   *
   * @remarks
   * This method handles the addition or update of a segmentation in the state.
   * If the segmentation already exists, it updates the existing segmentation.
   * If the segmentation does not exist, it adds a new segmentation.
   */
  public addOrUpdateSegmentation(
    data: cstTypes.SegmentationPublicInput | Partial<cstTypes.Segmentation>
  ) {
    const segmentationId = data.segmentationId;
    const existingSegmentation = cstSegmentation.state.getSegmentation(segmentationId);

    if (existingSegmentation) {
      // Update the existing segmentation
      this.updateSegmentationInSource(segmentationId, data as Partial<cstTypes.Segmentation>);
    } else {
      // Add a new segmentation
      this.addSegmentationToSource(data as cstTypes.SegmentationPublicInput);
    }
  }

  public setActiveSegmentation(viewportId: string, segmentationId: string): void {
    cstSegmentation.activeSegmentation.setActiveSegmentation(viewportId, segmentationId);
  }

  /**
   * Gets the active segmentation for a viewport
   * @param viewportId - The ID of the viewport to get the active segmentation for
   * @returns The active segmentation object, or null if no segmentation is active
   *
   * @remarks
   * This method retrieves the currently active segmentation for the specified viewport.
   * The active segmentation is the one that is currently selected for editing operations.
   * Returns null if no segmentation is active in the viewport.
   */
  public getActiveSegmentation(viewportId: string): cstTypes.Segmentation | null {
    return cstSegmentation.activeSegmentation.getActiveSegmentation(viewportId);
  }

  /**
   * Gets the active segment from the active segmentation in a viewport
   * @param viewportId - The ID of the viewport to get the active segment from
   * @returns The active segment object, or undefined if no segment is active
   *
   * @remarks
   * This method retrieves the currently active segment from the active segmentation
   * in the specified viewport. The active segment is the one that is currently
   * selected for editing operations. Returns undefined if no segment is active or
   * if there is no active segmentation.
   */
  public getActiveSegment(viewportId: string): cstTypes.Segment | undefined {
    const activeSegmentation = this.getActiveSegmentation(viewportId);

    if (!activeSegmentation) {
      return;
    }

    const { segments } = activeSegmentation;

    let activeSegment;
    for (const segment of Object.values(segments)) {
      if (segment.active) {
        activeSegment = segment;
        break;
      }
    }

    return activeSegment;
  }

  public hasCustomStyles(specifier: {
    viewportId: string;
    segmentationId: string;
    type: SegmentationRepresentations;
  }): boolean {
    return cstSegmentation.config.style.hasCustomStyle(specifier);
  }

  public getStyle = (specifier: {
    viewportId: string;
    segmentationId: string;
    type: SegmentationRepresentations;
    segmentIndex?: number;
  }) => {
    const style = cstSegmentation.config.style.getStyle(specifier);

    return style;
  };

  public setStyle = (
    specifier: {
      type: SegmentationRepresentations;
      viewportId?: string;
      segmentationId?: string;
      segmentIndex?: number;
    },
    style: LabelmapStyle | ContourStyle | SurfaceStyle
  ) => {
    cstSegmentation.config.style.setStyle(specifier, style);
  };

  public resetToGlobalStyle = () => {
    cstSegmentation.config.style.resetToGlobalStyle();
  };

  /**
   * Adds a new segment to the specified segmentation.
   * @param segmentationId - The ID of the segmentation to add the segment to.
   * @param viewportId: The ID of the viewport to add the segment to, it is used to get the representation, if it is not
   * provided, the first available representation for the segmentationId will be used.
   * @param config - An object containing the configuration options for the new segment.
   *   - segmentIndex: (optional) The index of the segment to add. If not provided, the next available index will be used.
   *   - properties: (optional) An object containing the properties of the new segment.
   *     - label: (optional) The label of the new segment. If not provided, a default label will be used.
   *     - color: (optional) The color of the new segment in RGB format. If not provided, a default color will be used.
   *     - visibility: (optional) Whether the new segment should be visible. If not provided, the segment will be visible by default.
   *     - isLocked: (optional) Whether the new segment should be locked for editing. If not provided, the segment will not be locked by default.
   *     - active: (optional) Whether the new segment should be the active segment to be edited. If not provided, the segment will not be active by default.
   */
  public addSegment(
    segmentationId: string,
    config: {
      segmentIndex?: number;
      label?: string;
      isLocked?: boolean;
      active?: boolean;
      color?: csTypes.Color; // Add color type
      visibility?: boolean; // Add visibility option
    } = {}
  ): void {
    if (config?.segmentIndex === 0) {
      throw new Error(i18n.t('Segment') + ' index 0 is reserved for "no label"');
    }

    const csSegmentation = this.getCornerstoneSegmentation(segmentationId);

    let segmentIndex = config.segmentIndex;
    if (!segmentIndex) {
      // grab the next available segment index based on the object keys,
      // so basically get the highest segment index value + 1
      const segmentKeys = Object.keys(csSegmentation.segments);
      segmentIndex = segmentKeys.length === 0 ? 1 : Math.max(...segmentKeys.map(Number)) + 1;
    }

    // update the segmentation
    if (!config.label) {
      config.label = `Label ${segmentIndex}`;
    }

    const currentSegments = csSegmentation.segments;

    cstSegmentation.updateSegmentations([
      {
        segmentationId,
        payload: {
          segments: {
            ...currentSegments,
            [segmentIndex]: {
              ...currentSegments[segmentIndex],
              segmentIndex,
              cachedStats: {},
              locked: false,
              ...config,
            },
          },
        },
      },
    ]);

    this.setActiveSegment(segmentationId, segmentIndex);

    // Apply additional configurations
    if (config.isLocked !== undefined) {
      this._setSegmentLockedStatus(segmentationId, segmentIndex, config.isLocked);
    }

    // Get all viewports that have this segmentation
    const viewportIds = this.getViewportIdsWithSegmentation(segmentationId);

    viewportIds.forEach(viewportId => {
      // Set color if provided
      if (config.color !== undefined) {
        this.setSegmentColor(viewportId, segmentationId, segmentIndex, config.color);
      }

      // Set visibility if provided
      if (config.visibility !== undefined) {
        this.setSegmentVisibility(viewportId, segmentationId, segmentIndex, config.visibility);
      }
    });

    this._broadcastEvent(this.EVENTS.SEGMENTATION_MODIFIED, { segmentationId });
  }

  /**
   * Removes a segment from a segmentation and updates the active segment index if necessary.
   *
   * @param segmentationId - The ID of the segmentation containing the segment to remove.
   * @param segmentIndex - The index of the segment to remove.
   *
   * @remarks
   * This method performs the following actions:
   * 1. Clears the segment value in the Cornerstone segmentation.
   * 2. Updates all related segmentation representations to remove the segment.
   * 3. If the removed segment was the active segment, it updates the active segment index.
   *
   */
  public removeSegment(segmentationId: string, segmentIndex: number): void {
    this._clearSegmentFromDynamicBuffers(segmentationId, segmentIndex);
    this._clearSegmentFromLabelmapData(segmentationId, segmentIndex);
    cstSegmentation.removeSegment(segmentationId, segmentIndex);
    triggerSegmentationRenderBySegmentationId(segmentationId);
  }

  public setSegmentVisibility(
    viewportId: string,
    segmentationId: string,
    segmentIndex: number,
    isVisible: boolean,
    type?: SegmentationRepresentations
  ): void {
    this._setSegmentVisibility(viewportId, segmentationId, segmentIndex, isVisible, type);
  }

  /**
   * Sets the locked status of a segment in a segmentation.
   *
   * @param segmentationId - The ID of the segmentation containing the segment.
   * @param segmentIndex - The index of the segment to set the locked status for.
   * @param isLocked - The new locked status of the segment.
   *
   * @remarks
   * This method updates the locked status of a specific segment within a segmentation.
   * A locked segment cannot be modified or edited.
   */
  public setSegmentLocked(segmentationId: string, segmentIndex: number, isLocked: boolean): void {
    this._setSegmentLockedStatus(segmentationId, segmentIndex, isLocked);
  }

  /**
   * Toggles the locked state of a segment in a segmentation.
   * @param segmentationId - The ID of the segmentation.
   * @param segmentIndex - The index of the segment to toggle.
   */
  public toggleSegmentLocked(segmentationId: string, segmentIndex: number): void {
    const isLocked = cstSegmentation.segmentLocking.isSegmentIndexLocked(
      segmentationId,
      segmentIndex
    );
    this._setSegmentLockedStatus(segmentationId, segmentIndex, !isLocked);
  }

  public toggleSegmentVisibility(
    viewportId: string,
    segmentationId: string,
    segmentIndex: number,
    type: SegmentationRepresentations
  ): void {
    const isVisible = cstSegmentation.config.visibility.getSegmentIndexVisibility(
      viewportId,
      {
        segmentationId,
        type,
      },
      segmentIndex
    );
    this._setSegmentVisibility(viewportId, segmentationId, segmentIndex, !isVisible, type);
  }

  /**
   * Sets the color of a specific segment in a segmentation.
   *
   * @param viewportId - The ID of the viewport containing the segmentation
   * @param segmentationId - The ID of the segmentation containing the segment
   * @param segmentIndex - The index of the segment to set the color for
   * @param color - The new color to apply to the segment as an array of RGBA values
   *
   * @remarks
   * This method updates the color of a specific segment within a segmentation.
   * The color parameter should be an array of 4 numbers representing RGBA values.
   */
  public setSegmentColor(
    viewportId: string,
    segmentationId: string,
    segmentIndex: number,
    color: csTypes.Color
  ): void {
    cstSegmentation.config.color.setSegmentIndexColor(
      viewportId,
      segmentationId,
      segmentIndex,
      color
    );
  }

  /**
   * Gets the current color of a specific segment in a segmentation.
   *
   * @param viewportId - The ID of the viewport containing the segmentation
   * @param segmentationId - The ID of the segmentation containing the segment
   * @param segmentIndex - The index of the segment to get the color for
   * @returns An array of 4 numbers representing the RGBA color values of the segment
   *
   * @remarks
   * This method retrieves the current color of a specific segment within a segmentation.
   * The returned color is an array of 4 numbers representing RGBA values.
   */
  public getSegmentColor(viewportId: string, segmentationId: string, segmentIndex: number) {
    return cstSegmentation.config.color.getSegmentIndexColor(
      viewportId,
      segmentationId,
      segmentIndex
    );
  }

  /**
   * Gets the labelmap volume for a segmentation
   * @param segmentationId - The ID of the segmentation to get the labelmap volume for
   * @returns The labelmap volume for the segmentation, or null if not found
   *
   * @remarks
   * This method retrieves the labelmap volume data for a specific segmentation.
   * The labelmap volume contains the actual segmentation data in the form of a 3D volume.
   * Returns null if the segmentation does not have valid labelmap volume data.
   */
  public getLabelmapVolume(segmentationId: string) {
    const csSegmentation = cstSegmentation.state.getSegmentation(segmentationId);
    const labelmapData = csSegmentation.representationData[
      SegmentationRepresentations.Labelmap
    ] as cstTypes.LabelmapToolOperationDataVolume;

    if (!labelmapData || !labelmapData.volumeId) {
      return null;
    }

    const { volumeId } = labelmapData;
    const labelmapVolume = cache.getVolume(volumeId);

    return labelmapVolume;
  }

  /**
   * Sets the label for a specific segment in a segmentation
   * @param segmentationId - The ID of the segmentation containing the segment
   * @param segmentIndex - The index of the segment to set the label for
   * @param label - The new label to apply to the segment
   *
   * @remarks
   * This method updates the text label of a specific segment within a segmentation.
   * The label is used to identify and describe the segment in the UI.
   */
  public setSegmentLabel(segmentationId: string, segmentIndex: number, label: string) {
    this._setSegmentLabel(segmentationId, segmentIndex, label);
  }

  /**
   * Sets the active segment for a segmentation
   * @param segmentationId - The ID of the segmentation containing the segment
   * @param segmentIndex - The index of the segment to set as active
   *
   * @remarks
   * This method updates which segment is considered "active" within a segmentation.
   * The active segment is typically highlighted and available for editing operations.
   */
  public setActiveSegment(segmentationId: string, segmentIndex: number): void {
    this._setActiveSegment(segmentationId, segmentIndex);
    this._broadcastEvent(this.EVENTS.ACTIVE_SEGMENT_MODIFIED, {
      segmentationId,
      segmentIndex,
    });
  }

  /**
   * Controls whether inactive segmentations should be rendered in a viewport
   * @param viewportId - The ID of the viewport to update
   * @param renderInactive - Whether inactive segmentations should be rendered
   *
   * @remarks
   * This method configures if segmentations that are not currently active
   * should still be visible in the specified viewport. This can be useful
   * for comparing or viewing multiple segmentations simultaneously.
   */
  public setRenderInactiveSegmentations(viewportId: string, renderInactive: boolean): void {
    cstSegmentation.config.style.setRenderInactiveSegmentations(viewportId, renderInactive);
  }

  /**
   * Gets whether inactive segmentations are being rendered for a viewport
   * @param viewportId - The ID of the viewport to check
   * @returns boolean indicating if inactive segmentations are rendered
   *
   * @remarks
   * This method retrieves the current rendering state for inactive segmentations
   * in the specified viewport. Returns true if inactive segmentations are visible.
   */
  public getRenderInactiveSegmentations(viewportId: string): boolean {
    return cstSegmentation.config.style.getRenderInactiveSegmentations(viewportId);
  }
  /**
   * Sets statistics for a group of segmentations
   * @param segmentationIds - Array of segmentation IDs that form the group
   * @param stats - Statistics object containing metrics for the segmentation group
   *
   * @remarks
   * This method stores statistical data for a group of related segmentations.
   * The stats are stored using a composite key created from the sorted and joined
   */
  public setSegmentationGroupStats(segmentationIds: string[], stats: any) {
    const groupId = this.getGroupId(segmentationIds);
    this._segmentationGroupStatsMap.set(groupId, stats);
  }

  /**
   * Gets statistics for a group of segmentations
   * @param segmentationIds - Array of segmentation IDs that form the group
   * @returns The stored statistics object for the segmentation group if found, undefined otherwise
   */
  public getSegmentationGroupStats(segmentationIds: string[]) {
    const groupId = this.getGroupId(segmentationIds);
    return this._segmentationGroupStatsMap.get(groupId);
  }

  private getGroupId(segmentationIds: string[]) {
    return segmentationIds.sort().join(',');
  }

  /**
   * Toggles the visibility of a segmentation in the state, and broadcasts the event.
   * Note: this method does not update the segmentation state in the source. It only
   * updates the state, and there should be separate listeners for that.
   * @param ids segmentation ids
   */
  public toggleSegmentationRepresentationVisibility = (
    viewportId: string,
    { segmentationId, type }: { segmentationId: string; type: SegmentationRepresentations }
  ): void => {
    this._toggleSegmentationRepresentationVisibility(viewportId, segmentationId, type);
  };

  public getViewportIdsWithSegmentation = (segmentationId: string): string[] => {
    const viewportIds = cstSegmentation.state.getViewportIdsWithSegmentation(segmentationId);
    return viewportIds;
  };

  /**
   * Clears segmentation representations from the viewport.
   * Unlike removeSegmentationRepresentations, this doesn't update
   * removed display set and representation maps.
   * We track removed segmentations manually to avoid re-adding them
   * when the display set is added again.
   * @param viewportId - The viewport ID to clear segmentation representations from.
   */
  public clearSegmentationRepresentations(viewportId: string): void {
    this.removeSegmentationRepresentations(viewportId);
  }

  /**
   * Completely removes a segmentation from the state
   * @param segmentationId - The ID of the segmentation to remove.
   */
  public remove(segmentationId: string): void {
    cstSegmentation.state.removeSegmentation(segmentationId);
  }

  public removeAllSegmentations(): void {
    cstSegmentation.state.removeAllSegmentations();
  }

  /**
   * It removes the segmentation representations from the viewport.
   * @param viewportId - The viewport id to remove the segmentation representations from.
   * @param specifier - The specifier to remove the segmentation representations.
   *
   * @remarks
   * If no specifier is provided, all segmentation representations for the viewport are removed.
   * If a segmentationId specifier is provided, only the segmentation representation with the specified segmentationId and type are removed.
   * If a type specifier is provided, only the segmentation representation with the specified type are removed.
   * If both a segmentationId and type specifier are provided, only the segmentation representation with the specified segmentationId and type are removed.
   */
  public removeSegmentationRepresentations(
    viewportId: string,
    specifier: {
      segmentationId?: string;
      type?: SegmentationRepresentations;
    } = {}
  ): void {
    cstSegmentation.removeSegmentationRepresentations(viewportId, specifier);
  }

  public jumpToSegmentCenter(
    segmentationId: string,
    segmentIndex: number,
    viewportId?: string,
    highlightAlpha = 0.9,
    highlightSegment = true,
    animationLength = 750,
    highlightHideOthers = false,
    highlightFunctionType = 'ease-in-out' // todo: make animation functions configurable from outside
  ): void {
    const center = this._getSegmentCenter(segmentationId, segmentIndex);
    if (!center) {
      console.warn('No center found for segmentation', segmentationId, segmentIndex);
      return;
    }

    const { world } = center as { world: csTypes.Point3 };

    // need to find which viewports are displaying the segmentation
    const viewportIds = viewportId
      ? [viewportId]
      : this.getViewportIdsWithSegmentation(segmentationId);

    viewportIds.forEach(viewportId => {
      const { viewport } = getEnabledElementByViewportId(viewportId);
      viewport.jumpToWorld(world);

      highlightSegment &&
        this.highlightSegment(
          segmentationId,
          segmentIndex,
          viewportId,
          highlightAlpha,
          animationLength,
          highlightHideOthers
        );
    });
  }

  public highlightSegment(
    segmentationId: string,
    segmentIndex: number,
    viewportId?: string,
    alpha = 0.9,
    animationLength = 750,
    hideOthers = true,
    highlightFunctionType = 'ease-in-out'
  ): void {
    if (this.highlightIntervalId) {
      clearInterval(this.highlightIntervalId);
    }

    const csSegmentation = this.getCornerstoneSegmentation(segmentationId);

    const viewportIds = viewportId
      ? [viewportId]
      : this.getViewportIdsWithSegmentation(segmentationId);

    viewportIds.forEach(viewportId => {
      const segmentationRepresentation = this.getSegmentationRepresentations(viewportId, {
        segmentationId,
      });

      const representation = segmentationRepresentation[0];
      const { type } = representation;
      const segments = csSegmentation.segments;

      const highlightFn =
        type === LABELMAP ? this._highlightLabelmap.bind(this) : this._highlightContour.bind(this);

      const adjustedAlpha = type === LABELMAP ? alpha : 1 - alpha;

      highlightFn(
        segmentIndex,
        adjustedAlpha,
        hideOthers,
        segments,
        viewportId,
        animationLength,
        representation
      );
    });
  }

  private getAndValidateViewport(viewportId: string) {
    const csViewport =
      this.servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (!csViewport) {
      console.warn(`Viewport with id ${viewportId} not found.`);
      return null;
    }
    return csViewport;
  }

  /**
   * Sets the visibility of a segmentation representation.
   *
   * @param viewportId - The ID of the viewport.
   * @param segmentationId - The ID of the segmentation.
   * @param isVisible - The new visibility state.
   */
  private _setSegmentationRepresentationVisibility(
    viewportId: string,
    segmentationId: string,
    type: SegmentationRepresentations,
    isVisible: boolean
  ): void {
    const representations = this.getSegmentationRepresentations(viewportId, {
      segmentationId,
      type,
    });
    const representation = representations[0];

    if (!representation) {
      console.log(
        'No segmentation representation found for the given viewportId and segmentationId'
      );
      return;
    }

    cstSegmentation.config.visibility.setSegmentationRepresentationVisibility(
      viewportId,
      {
        segmentationId,
        type,
      },
      isVisible
    );
  }

  private determineViewportAndSegmentationType(csViewport, segmentation) {
    const isVolumeViewport =
      csViewport.type === ViewportType.ORTHOGRAPHIC || csViewport.type === ViewportType.VOLUME_3D;
    const isVolumeSegmentation = 'volumeId' in segmentation.representationData[LABELMAP];
    return { isVolumeViewport, isVolumeSegmentation };
  }

  private async handleViewportConversion(
    isVolumeViewport: boolean,
    isVolumeSegmentation: boolean,
    csViewport: csTypes.IViewport,
    segmentation: cstTypes.Segmentation,
    viewportId: string,
    segmentationId: string,
    representationType: csToolsEnums.SegmentationRepresentations
  ): Promise<{
    representationTypeToUse: SegmentationRepresentations;
    isConverted: boolean;
    shouldAddRepresentation: boolean;
  }> {
    let representationTypeToUse = representationType;
    let isConverted = false;
    let shouldAddRepresentation = true;

    const handler = isVolumeViewport ? this.handleVolumeViewportCase : this.handleStackViewportCase;

    ({ representationTypeToUse, isConverted, shouldAddRepresentation } = await handler.apply(this, [
      csViewport,
      segmentation,
      isVolumeSegmentation,
      viewportId,
      segmentationId,
    ]));

    return { representationTypeToUse, isConverted, shouldAddRepresentation };
  }

  private async handleVolumeViewportCase(csViewport, segmentation, isVolumeSegmentation) {
    if (csViewport.type === ViewportType.VOLUME_3D) {
      return {
        representationTypeToUse: SegmentationRepresentations.Surface,
        isConverted: false,
        shouldAddRepresentation: true,
      };
    } else {
      const shouldAddRepresentation = await this.handleVolumeViewport(
        csViewport as csTypes.IVolumeViewport,
        segmentation,
        isVolumeSegmentation
      );
      return {
        representationTypeToUse: SegmentationRepresentations.Labelmap,
        isConverted: false,
        shouldAddRepresentation,
      };
    }
  }

  private async handleStackViewportCase(
    csViewport: csTypes.IViewport,
    segmentation: cstTypes.Segmentation,
    isVolumeSegmentation: boolean,
    viewportId: string,
    segmentationId: string
  ): Promise<{
    representationTypeToUse: SegmentationRepresentations;
    isConverted: boolean;
    shouldAddRepresentation: boolean;
  }> {
    if (isVolumeSegmentation) {
      const referencedImageIds = getSanitizedLabelmapReferencedImageIds(
        segmentation.segmentationId
      );
      if (!hasReconstructableImageGeometry(referencedImageIds)) {
        return {
          representationTypeToUse: SegmentationRepresentations.Labelmap,
          isConverted: false,
          shouldAddRepresentation: true,
        };
      }

      if (this._shouldSkipVolumeViewportConversion()) {
        return {
          representationTypeToUse: SegmentationRepresentations.Labelmap,
          isConverted: false,
          shouldAddRepresentation: false,
        };
      }

      const isConverted = await this.convertStackToVolumeViewport(csViewport);
      return {
        representationTypeToUse: SegmentationRepresentations.Labelmap,
        isConverted,
        shouldAddRepresentation: true,
      };
    }

    if (updateLabelmapSegmentationImageReferences(viewportId, segmentationId)) {
      this._warnIfCPURenderingBlocksBrush();
      return {
        representationTypeToUse: SegmentationRepresentations.Labelmap,
        isConverted: false,
        shouldAddRepresentation: true,
      };
    }

    const { isConverted, shouldAddRepresentation } = await this.attemptStackToVolumeConversion(
      csViewport as csTypes.IStackViewport,
      segmentation,
      viewportId,
      segmentationId
    );

    return {
      representationTypeToUse: SegmentationRepresentations.Labelmap,
      isConverted,
      shouldAddRepresentation,
    };
  }

  private async _addSegmentationRepresentation(
    viewportId: string,
    segmentationId: string,
    representationType: csToolsEnums.SegmentationRepresentations,
    colorLUTIndex: number,
    isConverted: boolean,
    config?: {
      blendMode?: csEnums.BlendModes;
    }
  ): Promise<void> {
    const representation = {
      type: representationType,
      segmentationId,
      config: { colorLUTOrIndex: colorLUTIndex, ...config },
    };

    const addRepresentation = () => {
      cstSegmentation.addSegmentationRepresentations(viewportId, [representation]);
    };

    if (isConverted) {
      const { viewportGridService } = this.servicesManager.services;
      await new Promise<void>(resolve => {
        const { unsubscribe } = viewportGridService.subscribe(
          viewportGridService.EVENTS.GRID_STATE_CHANGED,
          event => {
            addRepresentation();
            unsubscribe();
            resolve();
          }
        );
      });
    } else {
      addRepresentation();
    }
  }
  private async handleVolumeViewport(
    viewport: csTypes.IVolumeViewport,
    segmentation: SegmentationData,
    isVolumeSegmentation: boolean
  ): Promise<boolean> {
    if (isVolumeSegmentation) {
      return true; // Volume Labelmap on Volume Viewport is natively supported
    }

    const frameOfReferenceUID = viewport.getFrameOfReferenceUID();
    const imageIds = getSanitizedLabelmapImageIds(segmentation.segmentationId);
    const referencedImageIds = getSanitizedLabelmapReferencedImageIds(segmentation.segmentationId);
    if (!imageIds.length) {
      return false;
    }

    const segImage = cache.getImage(imageIds[0]);

    if (segImage?.FrameOfReferenceUID !== frameOfReferenceUID) {
      return false;
    }

    const volumeIds = viewport.getAllVolumeIds?.() ?? [];
    const dynamicVolumeId = volumeIds.find(id => cache.getVolume(id)?.isDynamicVolume?.());

    if (!dynamicVolumeId) {
      if (!hasReconstructableImageGeometry(referencedImageIds)) {
        return false;
      }

      // Static 3D volume: use the standard conversion path.
      await convertStackToVolumeLabelmap(segmentation);
      return true;
    }

    // Dynamic-volume (3D+T) viewport.
    //
    // CornerstoneJS's addLabelmapToElement takes the VolumeViewport path and calls
    // _handleMissingVolume → createAndCacheVolumeFromImages, which produces a volume with
    // hasScalarVolume=false → VTK.js shader program null → TypeError: null.isAttributeUsed.
    //
    // Fix: pre-create a Uint8Array-backed derived labelmap volume, inject its ID into
    // CornerstoneJS segmentation state so addLabelmapToElement finds it in cache and skips
    // _handleMissingVolume. Then maintain per-timepoint Uint8Array buffers and swap scalar
    // data in-place whenever the dynamic volume's timepoint changes.
    const segId = segmentation.segmentationId;
    const labelmapVolumeId = `derived-labelmap-${segId}`;
    const dynamicVolume = cache.getVolume(dynamicVolumeId) as any;
    const numTimePoints: number =
      dynamicVolume?.numTimePoints ?? dynamicVolume?.numDimensionGroups ?? 1;
    logDynamicSegmentation('handleVolumeViewport:dynamic-detected', {
      segmentationId: segId,
      dynamicVolumeId,
      labelmapVolumeId,
      numTimePoints,
      dimensionGroupNumber: dynamicVolume?.dimensionGroupNumber,
      hasScalarVolume: dynamicVolume?.hasScalarVolume,
    });

    if (!cache.getVolume(labelmapVolumeId)) {
      volumeLoader.createLocalLabelmapVolume(
        {
          metadata: structuredClone(dynamicVolume.metadata),
          dimensions: [
            dynamicVolume.dimensions[0],
            dynamicVolume.dimensions[1],
            dynamicVolume.dimensions[2],
          ],
          spacing: dynamicVolume.spacing,
          origin: dynamicVolume.origin,
          direction: dynamicVolume.direction,
          scalarData: new Uint8Array(
            dynamicVolume.dimensions[0] * dynamicVolume.dimensions[1] * dynamicVolume.dimensions[2]
          ),
        },
        labelmapVolumeId
      );
      const createdLabelmapVolume = cache.getVolume(labelmapVolumeId) as any;
      createdLabelmapVolume.referencedVolumeId = dynamicVolumeId;
      createdLabelmapVolume.referencedImageIds = dynamicVolume.imageIds ?? [];
      logDynamicSegmentation('handleVolumeViewport:derived-labelmap-created', {
        segmentationId: segId,
        labelmapVolumeId,
        hasScalarVolume: createdLabelmapVolume?.hasScalarVolume,
        imageIds: createdLabelmapVolume?.imageIds?.length || 0,
      });
    }

    // Inject volumeId so addLabelmapToElement → _ensureVolumeHasVolumeId picks our volume.
    const csSeg = cstSegmentation.state.getSegmentation(segId);
    if (csSeg?.representationData?.Labelmap) {
      (csSeg.representationData.Labelmap as any).volumeId = labelmapVolumeId;
    }

    // Build per-timepoint scalar buffers — one zeroed Uint8Array per timepoint.
    // Timepoint 0 is already "live" inside the derived volume's voxelManager.
    if (!this._dynamicSegmentationMap.has(segId)) {
      const labelmapVolume = cache.getVolume(labelmapVolumeId) as any;
      const scalarLength: number = labelmapVolume.voxelManager.getScalarDataLength();
      const scalarBuffers: Uint8Array[] = Array.from(
        { length: numTimePoints },
        () => new Uint8Array(scalarLength)
      );
      const currentTimePoint = Math.max(1, Number(dynamicVolume?.dimensionGroupNumber) || 1) - 1;
      const activeScalar = readVolumeScalarDataFromImages(labelmapVolume);
      if (activeScalar && scalarBuffers[currentTimePoint]) {
        scalarBuffers[currentTimePoint].set(activeScalar);
      }
      logDynamicSegmentation('handleVolumeViewport:dynamic-map-registered', {
        segmentationId: segId,
        labelmapVolumeId,
        dynamicVolumeId,
        numTimePoints,
        currentTimePoint,
        scalarLength,
        activeScalarAvailable: Boolean(activeScalar),
      });
      this._dynamicSegmentationMap.set(segId, {
        labelmapVolumeId,
        dynamicVolumeId,
        numTimePoints,
        currentTimePoint,
        scalarBuffers,
      });
    }

    // Register the timepoint-change listener once per service lifetime.
    if (!this._dynamicVolumeListenerRegistered) {
      this._dynamicVolumeListenerRegistered = true;
      eventTarget.addEventListener(
        csEnums.Events.DYNAMIC_VOLUME_TIME_POINT_INDEX_CHANGED,
        this._onDynamicVolumeTimePointChanged
      );
    }

    return true;
  }

  /** Swaps per-timepoint scalar buffers when the cine player changes frame. */
  private _onDynamicVolumeTimePointChanged = (evt: Event): void => {
    const { volumeId: changedDynamicVolumeId, timePointIndex } = (evt as CustomEvent).detail;

    for (const [segId, state] of this._dynamicSegmentationMap.entries()) {
      if (state.dynamicVolumeId !== changedDynamicVolumeId) continue;

      const labelmapVolume = cache.getVolume(state.labelmapVolumeId) as any;
      if (!labelmapVolume) continue;

      const activeScalar = readVolumeScalarDataFromImages(labelmapVolume);
      if (!activeScalar) {
        logDynamicSegmentation('timePointChanged:no-scalar-data', {
          segmentationId: segId,
          labelmapVolumeId: state.labelmapVolumeId,
          fromTimePoint: state.currentTimePoint,
          toTimePoint: timePointIndex,
        });
        continue;
      }

      // Persist the current timepoint's edits into its buffer.
      const restoreWriteProtected =
        (state.restoreWriteProtectedUntil || 0) > Date.now() &&
        state.restoredTimePoints?.has(state.currentTimePoint);
      const activeScalarIsEmpty = countNonZero(activeScalar) === 0;
      const currentBufferHasData = countNonZero(state.scalarBuffers[state.currentTimePoint]) > 0;

      if (restoreWriteProtected && activeScalarIsEmpty && currentBufferHasData) {
        logDynamicSegmentation('timePointChanged:skip-empty-restore-overwrite', {
          segmentationId: segId,
          labelmapVolumeId: state.labelmapVolumeId,
          fromTimePoint: state.currentTimePoint,
          toTimePoint: timePointIndex,
          protectedUntil: state.restoreWriteProtectedUntil,
        });
      } else {
        state.scalarBuffers[state.currentTimePoint].set(activeScalar);
      }

      // Restore the target timepoint's data into the live scalar buffer in-place.
      if (!writeVolumeScalarDataToImages(labelmapVolume, state.scalarBuffers[timePointIndex])) {
        logDynamicSegmentation('timePointChanged:write-failed', {
          segmentationId: segId,
          labelmapVolumeId: state.labelmapVolumeId,
          toTimePoint: timePointIndex,
        });
        continue;
      }
      state.currentTimePoint = timePointIndex;

      // Invalidate the GPU texture so VTK re-uploads the updated scalar data.
      labelmapVolume.invalidate();
      triggerSegmentationRenderBySegmentationId(segId);
      logDynamicSegmentation('timePointChanged:applied', {
        segmentationId: segId,
        fromTimePoint: state.currentTimePoint,
        toTimePoint: timePointIndex,
      });
    }
  };

  private async convertStackToVolumeViewport(viewport: csTypes.IViewport): Promise<boolean> {
    const { viewportGridService, cornerstoneViewportService } = this.servicesManager.services;
    const state = viewportGridService.getState();
    const gridViewport = state.viewports.get(viewport.id);

    const prevViewPresentation = viewport.getViewPresentation();
    const prevViewReference = viewport.getViewReference();
    const stackViewport = cornerstoneViewportService.getCornerstoneViewport(viewport.id);
    const { element } = stackViewport;

    const volumeViewportNewVolumeHandler = () => {
      const volumeViewport = cornerstoneViewportService.getCornerstoneViewport(viewport.id);
      volumeViewport.setViewPresentation(prevViewPresentation);
      volumeViewport.setViewReference(prevViewReference);
      volumeViewport.render();

      element.removeEventListener(
        csEnums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
        volumeViewportNewVolumeHandler
      );
    };

    element.addEventListener(
      csEnums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
      volumeViewportNewVolumeHandler
    );

    viewportGridService.setDisplaySetsForViewport({
      viewportId: viewport.id,
      displaySetInstanceUIDs: gridViewport.displaySetInstanceUIDs,
      viewportOptions: {
        ...gridViewport.viewportOptions,
        viewportType: ViewportType.ORTHOGRAPHIC,
      },
    });

    return true;
  }

  private async attemptStackToVolumeConversion(
    viewport: csTypes.IStackViewport,
    segmentation: SegmentationData,
    viewportId: string,
    segmentationId: string
  ): Promise<{ isConverted: boolean; shouldAddRepresentation: boolean }> {
    const imageIds = getSanitizedLabelmapImageIds(segmentation.segmentationId);
    if (!imageIds.length) {
      return { isConverted: false, shouldAddRepresentation: false };
    }

    const referencedImageIds = getSanitizedLabelmapReferencedImageIds(segmentation.segmentationId);
    if (!hasReconstructableImageGeometry(referencedImageIds)) {
      return { isConverted: false, shouldAddRepresentation: true };
    }

    const frameOfReferenceUID = viewport.getFrameOfReferenceUID();
    const segImage = cache.getImage(imageIds[0]);

    if (
      segImage?.FrameOfReferenceUID &&
      frameOfReferenceUID &&
      segImage.FrameOfReferenceUID === frameOfReferenceUID
    ) {
      if (this._shouldSkipVolumeViewportConversion()) {
        return { isConverted: false, shouldAddRepresentation: true };
      }

      const isConverted = await this.convertStackToVolumeViewport(viewport);
      triggerSegmentationRepresentationModified(
        viewportId,
        segmentationId,
        SegmentationRepresentations.Labelmap
      );

      return { isConverted, shouldAddRepresentation: true };
    }

    return { isConverted: false, shouldAddRepresentation: true };
  }

  private _shouldSkipVolumeViewportConversion(): boolean {
    if (!cornerstone.getShouldUseCPURendering()) {
      return false;
    }

    if (!this._hasShownCPUFallbackVolumeSegmentationWarning) {
      const { uiNotificationService } = this.servicesManager.services;

      uiNotificationService.show({
        title: 'Segmentation limited in CPU rendering mode',
        message:
          'This segmentation needs a volume viewport, but CPU fallback rendering is enabled. The viewport will stay in stack mode.',
        type: 'warning',
      });

      this._hasShownCPUFallbackVolumeSegmentationWarning = true;
    }

    return true;
  }

  private _warnIfCPURenderingBlocksBrush(): void {
    if (!cornerstone.getShouldUseCPURendering()) {
      return;
    }

    if (!this._hasShownCPUFallbackBrushWarning) {
      const { uiNotificationService } = this.servicesManager.services;

      uiNotificationService.show({
        title: 'Brush unavailable in CPU rendering mode',
        message:
          'GPU rendering is disabled (WebGL unavailable). Segmentation labels cannot be created and the brush tool will not draw. Re-enable GPU rendering in your browser to use segmentation tools.',
        type: 'warning',
      });

      this._hasShownCPUFallbackBrushWarning = true;
    }
  }

  private addSegmentationToSource(segmentationPublicInput: cstTypes.SegmentationPublicInput) {
    cstSegmentation.addSegmentations([segmentationPublicInput]);
  }

  private updateSegmentationInSource(
    segmentationId: string,
    payload: Partial<cstTypes.Segmentation>
  ) {
    cstSegmentation.updateSegmentations([{ segmentationId, payload }]);
    this._broadcastEvent(this.EVENTS.SEGMENTATION_MODIFIED, { segmentationId });
  }

  private _toOHIFSegmentationRepresentation(
    viewportId: string,
    csRepresentation: cstTypes.SegmentationRepresentation
  ): SegmentationRepresentation {
    return toOHIFSegmentationRepresentation(viewportId, csRepresentation);
  }

  private _initSegmentationService() {
    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_MODIFIED,
      this._onSegmentationModifiedFromSource
    );

    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_REMOVED,
      this._onSegmentationModifiedFromSource
    );

    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED,
      this._onSegmentationDataModifiedFromSource
    );

    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_REPRESENTATION_MODIFIED,
      this._onSegmentationRepresentationModifiedFromSource
    );

    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_REPRESENTATION_ADDED,
      this._onSegmentationRepresentationModifiedFromSource
    );

    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_REPRESENTATION_REMOVED,
      this._onSegmentationRepresentationModifiedFromSource
    );

    eventTarget.addEventListener(
      csToolsEnums.Events.SEGMENTATION_ADDED,
      this._onSegmentationAddedFromSource
    );
  }

  private getCornerstoneSegmentation(segmentationId: string) {
    return cstSegmentation.state.getSegmentation(segmentationId);
  }

  private _highlightLabelmap(
    segmentIndex: number,
    alpha: number,
    hideOthers: boolean,
    segments: Segment[],
    viewportId: string,
    animationLength: number,
    representation: cstTypes.SegmentationRepresentation
  ) {
    highlightLabelmap(
      segmentIndex,
      alpha,
      hideOthers,
      segments,
      viewportId,
      animationLength,
      representation
    );
  }

  private _highlightContour(
    segmentIndex: number,
    alpha: number,
    hideOthers: boolean,
    segments: Segment[],
    viewportId: string,
    animationLength: number,
    representation: cstTypes.SegmentationRepresentation
  ) {
    highlightContour(
      segmentIndex,
      alpha,
      hideOthers,
      segments,
      viewportId,
      animationLength,
      representation
    );
  }

  private _toggleSegmentationRepresentationVisibility = (
    viewportId: string,
    segmentationId: string,
    type: SegmentationRepresentations
  ): void => {
    const representations = this.getSegmentationRepresentations(viewportId, {
      segmentationId,
      type,
    });
    const representation = representations[0];

    const segmentsHidden = cstSegmentation.config.visibility.getHiddenSegmentIndices(viewportId, {
      segmentationId,
      type: representation.type,
    });

    const currentVisibility = segmentsHidden.size === 0;
    this._setSegmentationRepresentationVisibility(
      viewportId,
      segmentationId,
      representation.type,
      !currentVisibility
    );
  };

  private _setActiveSegment(segmentationId: string, segmentIndex: number) {
    cstSegmentation.segmentIndex.setActiveSegmentIndex(segmentationId, segmentIndex);
  }

  private _getVolumeIdForDisplaySet(displaySet) {
    const volumeLoaderSchema = displaySet.volumeLoaderSchema ?? VOLUME_LOADER_SCHEME;

    return `${volumeLoaderSchema}:${displaySet.displaySetInstanceUID}`;
  }

  private _getSegmentCenter(segmentationId, segmentIndex) {
    const segmentation = this.getSegmentation(segmentationId);

    if (!segmentation) {
      return;
    }

    const { segments } = segmentation;

    const { cachedStats } = segments[segmentIndex];

    if (!cachedStats) {
      return;
    }

    const { center } = cachedStats;

    if (!center) {
      const namedCenter = cachedStats.namedStats?.center?.value;
      if (!namedCenter) {
        return;
      }
      return { world: namedCenter };
    }

    return center;
  }

  private _setSegmentLockedStatus(segmentationId: string, segmentIndex: number, isLocked: boolean) {
    cstSegmentation.segmentLocking.setSegmentIndexLocked(segmentationId, segmentIndex, isLocked);
  }

  private _setSegmentVisibility(
    viewportId: string,
    segmentationId: string,
    segmentIndex: number,
    isVisible: boolean,
    type?: SegmentationRepresentations
  ) {
    cstSegmentation.config.visibility.setSegmentIndexVisibility(
      viewportId,
      {
        segmentationId,
        type,
      },
      segmentIndex,
      isVisible
    );
  }

  private _setSegmentLabel(segmentationId: string, segmentIndex: number, segmentLabel: string) {
    const segmentation = this.getCornerstoneSegmentation(segmentationId);
    const { segments } = segmentation;

    segments[segmentIndex].label = segmentLabel;

    cstSegmentation.updateSegmentations([
      {
        segmentationId,
        payload: {
          segments,
        },
      },
    ]);

    this._broadcastEvent(this.EVENTS.SEGMENTATION_MODIFIED, { segmentationId });
  }

  private _onSegmentationDataModifiedFromSource = evt => {
    const { segmentationId, modifiedSlicesToUse, segmentIndex } = evt.detail;
    this.syncDynamicSegmentationCurrentTimePoint(segmentationId);
    this._broadcastEvent(this.EVENTS.SEGMENTATION_DATA_MODIFIED, {
      segmentationId,
      modifiedSlicesToUse,
      segmentIndex,
    });
  };

  private _onSegmentationRepresentationModifiedFromSource = evt => {
    const { segmentationId, viewportId } = evt.detail;
    this._broadcastEvent(this.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED, {
      segmentationId,
      viewportId,
    });
  };

  private _onSegmentationModifiedFromSource = (
    evt: cstTypes.EventTypes.SegmentationModifiedEventType
  ) => {
    const { segmentationId } = evt.detail;

    this._broadcastEvent(this.EVENTS.SEGMENTATION_MODIFIED, {
      segmentationId,
    });
  };

  private _onSegmentationAddedFromSource = (
    evt: cstTypes.EventTypes.SegmentationAddedEventType
  ) => {
    const { segmentationId } = evt.detail;

    this._broadcastEvent(this.EVENTS.SEGMENTATION_ADDED, {
      segmentationId,
    });
  };
}

export default SegmentationService;
export { EVENTS, VALUE_TYPES };
