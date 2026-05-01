import React, { useEffect, useState } from 'react';
import { SegmentationTable } from '@ohif/ui-next';
import { useActiveViewportSegmentationRepresentations } from '../hooks/useActiveViewportSegmentationRepresentations';
import { metaData } from '@cornerstonejs/core';
import { useSystem } from '@ohif/core/src';
import { useViewportGrid } from '@ohif/ui-next';
import {
  getSegmentationPersistenceStatus,
  subscribeSegmentationPersistenceStatus,
} from '../utils/segmentationPersistenceStatus';

function SegmentationPersistenceHud({ viewportId }: { viewportId?: string }) {
  const [status, setStatus] = useState(() => getSegmentationPersistenceStatus(viewportId));

  useEffect(() => {
    setStatus(getSegmentationPersistenceStatus(viewportId));
  }, [viewportId]);

  useEffect(() => {
    return subscribeSegmentationPersistenceStatus(() => {
      setStatus(getSegmentationPersistenceStatus(viewportId));
    });
  }, [viewportId]);

  if (!status || status.kind === 'idle') {
    return null;
  }

  const label =
    status.kind === 'error'
      ? 'Error'
      : status.kind === 'saving'
        ? 'Saving'
        : status.kind === 'loading'
          ? 'Loading'
          : status.kind === 'dirty'
            ? 'Unsaved'
            : 'Synced';

  const toneStyle =
    status.kind === 'error'
      ? {
          borderColor: 'rgba(239, 68, 68, 0.45)',
          backgroundColor: 'rgba(69, 10, 10, 0.85)',
          color: '#fee2e2',
        }
      : status.kind === 'saving' || status.kind === 'loading'
        ? {
            borderColor: 'rgba(56, 189, 248, 0.45)',
            backgroundColor: 'rgba(8, 47, 73, 0.85)',
            color: '#e0f2fe',
          }
        : status.kind === 'dirty'
          ? {
              borderColor: 'rgba(245, 158, 11, 0.45)',
              backgroundColor: 'rgba(69, 26, 3, 0.85)',
              color: '#fef3c7',
            }
          : {
              borderColor: 'rgba(16, 185, 129, 0.45)',
              backgroundColor: 'rgba(6, 46, 24, 0.85)',
              color: '#d1fae5',
            };

  return (
    <div
      data-cy="persistence-hud"
      data-hud-status={status.kind}
      className="rounded border px-3 py-2 text-xs shadow-sm"
      style={toneStyle}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium uppercase tracking-wide">{label}</span>
        <span className="opacity-70">
          {new Date(status.updatedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
      <div className="mt-1 leading-5">{status.message}</div>
    </div>
  );
}

export default function PanelSegmentation({ children }: withAppTypes) {
  const { commandsManager, servicesManager } = useSystem();
  const [{ activeViewportId }] = useViewportGrid();
  const { customizationService, displaySetService } = servicesManager.services;

  const { segmentationsWithRepresentations, disabled } =
    useActiveViewportSegmentationRepresentations({
      servicesManager,
    });

  // Extract customization options
  const segmentationTableMode = customizationService.getCustomization(
    'panelSegmentation.tableMode'
  ) as unknown as string;
  const onSegmentationAdd = customizationService.getCustomization(
    'panelSegmentation.onSegmentationAdd'
  );
  const disableEditing = customizationService.getCustomization('panelSegmentation.disableEditing');
  const showAddSegment = customizationService.getCustomization('panelSegmentation.showAddSegment');
  const CustomDropdownMenuContent = customizationService.getCustomization(
    'panelSegmentation.customDropdownMenuContent'
  );

  const CustomSegmentStatisticsHeader = customizationService.getCustomization(
    'panelSegmentation.customSegmentStatisticsHeader'
  );

  const CustomSegmentsList = customizationService.getCustomization(
    'panelSegmentation.customSegmentsList'
  );

  // Create handlers object for all command runs
  const handlers = {
    onSegmentationClick: (segmentationId: string) => {
      commandsManager.run('setActiveSegmentation', { segmentationId });
    },
    onSegmentAdd: segmentationId => {
      commandsManager.run('addSegment', { segmentationId });
    },
    onSegmentClick: (segmentationId, segmentIndex) => {
      commandsManager.run('setActiveSegmentAndCenter', { segmentationId, segmentIndex });
    },
    onSegmentEdit: (segmentationId, segmentIndex) => {
      commandsManager.run('editSegmentLabel', { segmentationId, segmentIndex });
    },
    onSegmentationEdit: segmentationId => {
      commandsManager.run('editSegmentationLabel', { segmentationId });
    },
    onSegmentColorClick: (segmentationId, segmentIndex) => {
      commandsManager.run('editSegmentColor', { segmentationId, segmentIndex });
    },
    onSegmentDelete: (segmentationId, segmentIndex) => {
      commandsManager.run('deleteSegment', { segmentationId, segmentIndex });
    },
    onToggleSegmentVisibility: (segmentationId, segmentIndex, type) => {
      commandsManager.run('toggleSegmentVisibility', { segmentationId, segmentIndex, type });
    },
    onToggleSegmentLock: (segmentationId, segmentIndex) => {
      commandsManager.run('toggleSegmentLock', { segmentationId, segmentIndex });
    },
    onToggleSegmentationRepresentationVisibility: (segmentationId, type) => {
      commandsManager.run('toggleSegmentationVisibility', { segmentationId, type });
    },
    onSegmentationDownload: segmentationId => {
      commandsManager.run('downloadSegmentation', { segmentationId });
    },
    setStyle: (segmentationId, type, key, value) => {
      commandsManager.run('setSegmentationStyle', { segmentationId, type, key, value });
    },
    toggleRenderInactiveSegmentations: () => {
      commandsManager.run('toggleRenderInactiveSegmentations');
    },
    onSegmentationRemoveFromViewport: segmentationId => {
      commandsManager.run('removeSegmentationFromViewport', { segmentationId });
    },
    onSegmentationDelete: segmentationId => {
      commandsManager.run('deleteSegmentation', { segmentationId });
    },
    setFillAlpha: ({ type }, value) => {
      commandsManager.run('setFillAlpha', { type, value });
    },
    setOutlineWidth: ({ type }, value) => {
      commandsManager.run('setOutlineWidth', { type, value });
    },
    setRenderFill: ({ type }, value) => {
      commandsManager.run('setRenderFill', { type, value });
    },
    setRenderOutline: ({ type }, value) => {
      commandsManager.run('setRenderOutline', { type, value });
    },
    setFillAlphaInactive: ({ type }, value) => {
      commandsManager.run('setFillAlphaInactive', { type, value });
    },
    getRenderInactiveSegmentations: () => {
      return commandsManager.run('getRenderInactiveSegmentations');
    },
  };

  // Generate export options
  const exportOptions = segmentationsWithRepresentations.map(({ segmentation }) => {
    const { representationData, segmentationId } = segmentation;
    const { Labelmap } = representationData;

    if (!Labelmap) {
      return { segmentationId, isExportable: true };
    }

    const referencedImageIds = Labelmap.referencedImageIds;
    const firstImageId = referencedImageIds[0];
    const instance = metaData.get('instance', firstImageId);

    if (!instance) {
      return { segmentationId, isExportable: false };
    }

    const SOPInstanceUID = instance.SOPInstanceUID || instance.SopInstanceUID;
    const SeriesInstanceUID = instance.SeriesInstanceUID;
    const displaySet = displaySetService.getDisplaySetForSOPInstanceUID(
      SOPInstanceUID,
      SeriesInstanceUID
    );

    return {
      segmentationId,
      isExportable: displaySet?.isReconstructable,
    };
  });

  // Common props for SegmentationTable
  const tableProps = {
    disabled,
    data: segmentationsWithRepresentations,
    mode: segmentationTableMode,
    title: 'Segmentations',
    exportOptions,
    disableEditing,
    onSegmentationAdd,
    showAddSegment,
    renderInactiveSegmentations: handlers.getRenderInactiveSegmentations(),
    ...handlers,
  };

  const renderSegments = () => {
    if (CustomSegmentsList) {
      return <CustomSegmentsList />;
    }

    return (
      <SegmentationTable.Segments>
        <SegmentationTable.SegmentStatistics.Header>
          <CustomSegmentStatisticsHeader />
        </SegmentationTable.SegmentStatistics.Header>
        <SegmentationTable.SegmentStatistics.Body />
      </SegmentationTable.Segments>
    );
  };

  // Render content based on mode
  const renderModeContent = () => {
    if (segmentationsWithRepresentations.length === 0) {
      return (
        <div
          data-cy="segmentation-empty-state"
          className="flex items-center justify-center py-4 text-base text-white/30 select-none"
        >
          No Segmentation
        </div>
      );
    }

    if (tableProps.mode === 'collapsed') {
      return (
        <SegmentationTable.Collapsed>
          <SegmentationTable.Collapsed.Header>
            <SegmentationTable.Collapsed.Selector />
            <SegmentationTable.Collapsed.DropdownMenu>
              <CustomDropdownMenuContent />
            </SegmentationTable.Collapsed.DropdownMenu>
          </SegmentationTable.Collapsed.Header>
          <SegmentationTable.Collapsed.Content>
            <SegmentationTable.AddSegmentRow />
            {renderSegments()}
          </SegmentationTable.Collapsed.Content>
        </SegmentationTable.Collapsed>
      );
    }

    return (
      <>
        <SegmentationTable.Expanded>
          <SegmentationTable.Expanded.Header>
            <SegmentationTable.Expanded.Label />
            <SegmentationTable.Expanded.DropdownMenu>
              <CustomDropdownMenuContent />
            </SegmentationTable.Expanded.DropdownMenu>
          </SegmentationTable.Expanded.Header>

          <SegmentationTable.Expanded.Content>
            <SegmentationTable.AddSegmentRow />
            {renderSegments()}
          </SegmentationTable.Expanded.Content>
        </SegmentationTable.Expanded>
      </>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SegmentationTable {...tableProps}>
          {children}
          <SegmentationTable.AddSegmentationRow />
          {renderModeContent()}
        </SegmentationTable>
      </div>
      <div className="sticky bottom-0 z-10 border-t border-white/10 bg-[#050816] px-2 py-3">
        <SegmentationPersistenceHud viewportId={activeViewportId} />
      </div>
    </div>
  );
}
