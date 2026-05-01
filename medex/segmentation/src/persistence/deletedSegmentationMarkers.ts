const STORAGE_KEY = 'medex.deletedSegmentations.v1';

type SegmentationMarkerIdentity = {
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  displaySetInstanceUID?: string;
};

const getMarkerKey = ({
  studyInstanceUID,
  seriesInstanceUID,
  displaySetInstanceUID,
}: SegmentationMarkerIdentity): string | undefined => {
  if (!studyInstanceUID || !seriesInstanceUID) {
    return undefined;
  }

  return [studyInstanceUID, seriesInstanceUID, displaySetInstanceUID || ''].join('|');
};

const readMarkers = (): Record<string, number> => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

const writeMarkers = (markers: Record<string, number>): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(markers));
};

export const markSegmentationDeletedForDisplaySet = (identity: SegmentationMarkerIdentity): void => {
  const markerKey = getMarkerKey(identity);
  if (!markerKey) {
    return;
  }

  writeMarkers({ ...readMarkers(), [markerKey]: Date.now() });
};

export const clearSegmentationDeletedForDisplaySet = (identity: SegmentationMarkerIdentity): void => {
  const markerKey = getMarkerKey(identity);
  if (!markerKey) {
    return;
  }

  const markers = readMarkers();
  delete markers[markerKey];
  const seriesLevelKey = getMarkerKey({
    studyInstanceUID: identity.studyInstanceUID,
    seriesInstanceUID: identity.seriesInstanceUID,
  });
  if (seriesLevelKey) {
    delete markers[seriesLevelKey];
  }
  writeMarkers(markers);
};

export const wasSegmentationDeletedForDisplaySet = (
  identity: SegmentationMarkerIdentity
): boolean => {
  const markerKey = getMarkerKey(identity);
  if (!markerKey) {
    return false;
  }

  const markers = readMarkers();
  const seriesLevelKey = getMarkerKey({
    studyInstanceUID: identity.studyInstanceUID,
    seriesInstanceUID: identity.seriesInstanceUID,
  });
  return Boolean(markers[markerKey] || (seriesLevelKey && markers[seriesLevelKey]));
};
