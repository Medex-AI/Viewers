export type SegmentationPhase = 'creating' | 'restoring' | 'armed' | 'error';

const _phase = new Map<string, SegmentationPhase>();
const _dirtyTimepoints = new Map<string, Set<number>>();

export function setPhase(segmentationId: string, phase: SegmentationPhase): void {
  _phase.set(segmentationId, phase);
}

export function getPhase(segmentationId: string): SegmentationPhase | undefined {
  return _phase.get(segmentationId);
}

export function isArmed(segmentationId: string): boolean {
  return getPhase(segmentationId) === 'armed';
}

export function canAutosave(segmentationId: string): boolean {
  return isArmed(segmentationId);
}

export function markDirty(segmentationId: string, timePointIndex: number): void {
  const dirty = _dirtyTimepoints.get(segmentationId) ?? new Set<number>();
  dirty.add(timePointIndex);
  _dirtyTimepoints.set(segmentationId, dirty);
}

export function clearDirty(segmentationId: string, timePointIndex?: number): void {
  if (timePointIndex === undefined) {
    _dirtyTimepoints.delete(segmentationId);
    return;
  }

  const dirty = _dirtyTimepoints.get(segmentationId);
  dirty?.delete(timePointIndex);
  if (dirty?.size === 0) {
    _dirtyTimepoints.delete(segmentationId);
  }
}

export function getDirtyTimepoints(segmentationId: string): ReadonlySet<number> {
  return _dirtyTimepoints.get(segmentationId) ?? new Set<number>();
}

export function hasDirty(segmentationId: string): boolean {
  return Boolean(_dirtyTimepoints.get(segmentationId)?.size);
}

export function destroy(segmentationId: string): void {
  _phase.delete(segmentationId);
  _dirtyTimepoints.delete(segmentationId);
}

export function destroyAll(): void {
  _phase.clear();
  _dirtyTimepoints.clear();
}
