type LabelMetadata = {
  name?: string;
  color?: string;
  locked?: boolean;
  visible?: boolean;
};

export type SegmentationDocument = {
  id: string;
  study_uid: string;
  series_uid: string;
  display_set_instance_uid?: string;
  model_type?: string;
  label: string;
  revision: number;
  labels: Record<string, LabelMetadata>;
};

const localToRemote = new Map<string, SegmentationDocument>();

const getAuthHeaders = (): Record<string, string> => {
  const token = window.localStorage.getItem('auth_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

export const bindSegmentationDocument = (
  localSegmentationId: string,
  document: SegmentationDocument
): void => {
  localToRemote.set(localSegmentationId, document);
};

export const getBoundSegmentationDocument = (
  localSegmentationId: string
): SegmentationDocument | undefined => localToRemote.get(localSegmentationId);

export const createBoundSegmentationDocument = async ({
  localSegmentationId,
  studyInstanceUID,
  seriesInstanceUID,
  displaySetInstanceUID,
  label,
  labels,
}: {
  localSegmentationId: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  displaySetInstanceUID?: string;
  label: string;
  labels: Record<number, LabelMetadata>;
}): Promise<SegmentationDocument | undefined> => {
  const response = await fetch('/api/segmentations', {
    method: 'POST',
    headers: getAuthHeaders(),
    credentials: 'include',
    body: JSON.stringify({
      study_uid: studyInstanceUID,
      series_uid: seriesInstanceUID,
      display_set_instance_uid: displaySetInstanceUID,
      model_type: 'segmentation',
      label,
      labels,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create segmentation metadata: ${response.status}`);
  }

  const body = await response.json();
  const created = body?.data?.segmentation;
  if (created) {
    localToRemote.set(localSegmentationId, created);
  }

  return created;
};

export const listSegmentationDocuments = async ({
  studyInstanceUID,
  seriesInstanceUID,
}: {
  studyInstanceUID: string;
  seriesInstanceUID: string;
}): Promise<SegmentationDocument[]> => {
  const search = new URLSearchParams({
    study: studyInstanceUID,
    series: seriesInstanceUID,
    model: 'segmentation',
  });
  const response = await fetch(`/api/segmentations?${search.toString()}`, {
    headers: getAuthHeaders(),
    credentials: 'include',
  });

  if (!response.ok) {
    return [];
  }

  const body = await response.json();
  return body?.data?.segmentations || [];
};

export const patchBoundLabel = async ({
  localSegmentationId,
  segmentIndex,
  name,
  color,
}: {
  localSegmentationId: string;
  segmentIndex: number;
  name?: string;
  color?: string;
}): Promise<void> => {
  const document = localToRemote.get(localSegmentationId);
  if (!document) {
    return;
  }

  const response = await fetch(`/api/segmentations/${document.id}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    credentials: 'include',
    body: JSON.stringify({
      base_revision: document.revision,
      labels: {
        [segmentIndex]: { name, color },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to persist label rename: ${response.status}`);
  }

  const body = await response.json();
  const updated = body?.data?.segmentation;
  if (updated) {
    localToRemote.set(localSegmentationId, updated);
  }
};

export const patchRemoveBoundLabel = async ({
  localSegmentationId,
  segmentIndex,
}: {
  localSegmentationId: string;
  segmentIndex: number;
}): Promise<void> => {
  const document = localToRemote.get(localSegmentationId);
  if (!document) {
    return;
  }

  const response = await fetch(`/api/segmentations/${document.id}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    credentials: 'include',
    body: JSON.stringify({
      base_revision: document.revision,
      remove_labels: [segmentIndex],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to persist label delete: ${response.status}`);
  }

  const body = await response.json();
  const updated = body?.data?.segmentation;
  if (updated) {
    localToRemote.set(localSegmentationId, updated);
  }
};
