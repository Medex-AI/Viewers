type AnnotationLike = {
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
} | null;

type AnnotationSeriesContext = {
  frameOfReferenceUID?: string | null;
  seriesInstanceUID?: string | null;
};

export const matchesAnnotationSeriesContext = (
  annotation: AnnotationLike,
  { frameOfReferenceUID, seriesInstanceUID }: AnnotationSeriesContext
) => {
  if (!annotation) {
    return false;
  }

  const metadata = annotation.metadata || {};
  const data = annotation.data || {};
  const annotationFrameUID = metadata.FrameOfReferenceUID || data.FrameOfReferenceUID;
  const annotationSeriesUID =
    metadata.SeriesInstanceUID || data.seriesInstanceUID || data.SeriesInstanceUID;

  if ((frameOfReferenceUID || seriesInstanceUID) && !annotationFrameUID && !annotationSeriesUID) {
    return false;
  }

  if (frameOfReferenceUID && annotationFrameUID && annotationFrameUID !== frameOfReferenceUID) {
    return false;
  }

  if (seriesInstanceUID && annotationSeriesUID && annotationSeriesUID !== seriesInstanceUID) {
    return false;
  }

  return true;
};
