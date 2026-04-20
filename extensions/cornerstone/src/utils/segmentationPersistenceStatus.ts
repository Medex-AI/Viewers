export type SegmentationPersistenceState = {
  kind: 'idle' | 'loading' | 'synced' | 'dirty' | 'saving' | 'error';
  message: string;
  updatedAt: number;
};

const statusByViewport = new Map<string, SegmentationPersistenceState>();
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach(listener => listener());
};

export const getSegmentationPersistenceStatus = (
  viewportId?: string | null
): SegmentationPersistenceState | null => {
  if (!viewportId) {
    return null;
  }

  return statusByViewport.get(viewportId) || null;
};

export const setSegmentationPersistenceStatus = (
  viewportId: string | undefined,
  state: Omit<SegmentationPersistenceState, 'updatedAt'> & { updatedAt?: number }
) => {
  if (!viewportId) {
    return;
  }

  statusByViewport.set(viewportId, {
    ...state,
    updatedAt: state.updatedAt ?? Date.now(),
  });
  emit();
};

export const clearSegmentationPersistenceStatus = (viewportId?: string | null) => {
  if (!viewportId) {
    return;
  }

  if (statusByViewport.delete(viewportId)) {
    emit();
  }
};

export const subscribeSegmentationPersistenceStatus = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};
