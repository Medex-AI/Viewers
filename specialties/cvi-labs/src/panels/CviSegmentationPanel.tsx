import React, { useCallback, useEffect, useState } from 'react';
import { useViewportGrid } from '@ohif/ui-next';
import { CVI_LABELS } from '../stores/cviLabsSegmentationStore';
import {
  activateCviCompatibleSegmentation,
  ensureCviSegmentationForViewport,
  listCompatibleCviSegmentations,
} from '../utils/cviSegmentation';

interface CviSegmentationPanelProps {
  servicesManager?: any;
}

const CviSegmentationPanel: React.FC<CviSegmentationPanelProps> = ({ servicesManager }) => {
  const [{ activeViewportId }] = useViewportGrid();
  const [segmentationOptions, setSegmentationOptions] = useState<any[]>([]);
  const [activeSegmentationId, setActiveSegmentationId] = useState('');

  const syncOptionsFromState = useCallback(() => {
    if (!servicesManager || !activeViewportId) {
      return;
    }

    const options = listCompatibleCviSegmentations(servicesManager, activeViewportId);
    const activeSegmentation = servicesManager.services?.segmentationService?.getActiveSegmentation?.(
      activeViewportId
    );

    setSegmentationOptions(options);
    setActiveSegmentationId(activeSegmentation?.segmentationId || activeSegmentation?.id || '');
  }, [activeViewportId, servicesManager]);

  const ensureAndSyncOptions = useCallback(async () => {
    if (!servicesManager || !activeViewportId) {
      return;
    }

    await ensureCviSegmentationForViewport(servicesManager, activeViewportId);
    syncOptionsFromState();
  }, [activeViewportId, servicesManager, syncOptionsFromState]);

  useEffect(() => {
    void ensureAndSyncOptions();
  }, [ensureAndSyncOptions]);

  useEffect(() => {
    const segmentationService = servicesManager?.services?.segmentationService;
    if (!segmentationService?.subscribe) {
      return;
    }

    const events = [
      segmentationService.EVENTS?.SEGMENTATION_ADDED,
      segmentationService.EVENTS?.SEGMENTATION_MODIFIED,
      segmentationService.EVENTS?.SEGMENTATION_REMOVED,
      segmentationService.EVENTS?.ACTIVE_SEGMENTATION_CHANGED,
    ].filter(Boolean);
    const subscriptions = events.map(event =>
      segmentationService.subscribe(event, syncOptionsFromState)
    );

    return () => subscriptions.forEach(subscription => subscription.unsubscribe());
  }, [servicesManager, syncOptionsFromState]);

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-y-auto bg-black p-3 text-white">
      <div className="rounded border border-gray-700 bg-gray-900 p-3">
        <div className="mb-2 text-sm font-semibold text-white">Cvi Labs Segmentation</div>
        <label className="mb-1 block text-xs text-gray-400" htmlFor="cvi-active-segmentation">
          Active segmentation
        </label>
        <select
          id="cvi-active-segmentation"
          aria-label="Cvi active segmentation"
          className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white"
          value={activeSegmentationId}
          onChange={event => {
            const segmentationId = event.target.value;
            setActiveSegmentationId(segmentationId);
            void activateCviCompatibleSegmentation({
              servicesManager,
              viewportId: activeViewportId,
              segmentationId,
            });
          }}
        >
          {segmentationOptions.map(option => (
            <option key={option.segmentationId} value={option.segmentationId}>
              {option.label || 'Cvi Lab'}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded border border-gray-700 bg-gray-900 p-3">
        <div className="mb-2 text-sm font-semibold text-white">Regions</div>
        <div className="space-y-2">
          {CVI_LABELS.map(label => {
            return (
              <div
                key={label.id}
                className="flex items-center justify-between rounded border border-gray-800 bg-gray-950 px-3 py-2"
                data-testid={`cvi-segmentation-row-${label.id}`}
                data-cy={`cvi-segmentation-row-${label.id}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  <span className="text-sm text-gray-100">{label.name}</span>
                </div>
                <span className="text-xs text-gray-500">Segment {label.segmentIndex}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default CviSegmentationPanel;
