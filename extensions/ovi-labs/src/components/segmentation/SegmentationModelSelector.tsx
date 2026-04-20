import React, { useState, useEffect, useRef } from 'react';
import { ModelType, getSegmentationState, setActiveModel, subscribeSegmentationState } from '../../utils/segmentationStore';
import { setModelParams, getModelParams } from '../../utils/segmentationParamsStore';
import segmentationApi, { ModelInfo } from '../../services/segmentationApi';
import SegmentationConfigModal from './SegmentationConfigModal';

interface SegmentationModelSelectorProps {
  commandsManager?: any;
  servicesManager?: any;
  onRecompute?: () => Promise<void> | void;
  isRecomputing?: boolean;
  recomputeStatusText?: string;
  onExportNifti?: (mode: 'label' | 'both') => void;
}

type ModelOption = {
  value: string;
  label: string;
  available: boolean;
  backendModel?: ModelInfo;
};

/**
 * Segmentation Model Selector with Backend Integration
 *
 * Features:
 * - Fetches available models from backend API (Sprint 3.2b)
 * - Three-dot menu for model configuration and download/export actions
 * - Supports manual, backend-driven models (otsu with no mask or hard mask)
 * - Graceful fallback to client-side when backend unavailable
 */
const SegmentationModelSelector: React.FC<SegmentationModelSelectorProps> = ({
  commandsManager,
  servicesManager,
  onRecompute,
  isRecomputing = false,
  recomputeStatusText,
  onExportNifti,
}) => {
  const [activeModel, setActiveModelState] = useState<ModelType>(getSegmentationState().activeModel);
  const [open, setOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([
    { value: 'manual', label: 'Manual', available: true },
  ]);
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [selectedModelInfo, setSelectedModelInfo] = useState<ModelInfo | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  const uiNotificationService = servicesManager?.services?.uiNotificationService;
  const toolGroupService = servicesManager?.services?.toolGroupService;

  // Fetch models from backend on mount
  useEffect(() => {
    const fetchModels = async () => {
      try {
        const isHealthy = await segmentationApi.healthCheck();
        if (!isHealthy) {
          console.warn('Segmentation backend not available, using client-side models');
          return;
        }

        const { models } = await segmentationApi.listModels();
        setBackendAvailable(true);

        // Add backend models to options (include unavailable ones but mark them)
        const backendOptions: ModelOption[] = models.map(model => ({
          value: model.model_id,
          label: model.name,
          available: model.can_run !== false, // Mark as unavailable if can_run is false
          backendModel: model,
        }));

        // Replace entire list (don't append to avoid duplicates on backend refresh)
        setModelOptions([
          { value: 'manual', label: 'Manual', available: true },
          ...backendOptions,
        ]);

        // Initialize default params for each model in the params store
        models.forEach(model => {
          const defaults: Record<string, any> = {};
          Object.entries(model.params_schema.properties || {}).forEach(([key, prop]: [string, any]) => {
            if (prop.default !== undefined) {
              defaults[key] = prop.default;
            }
          });
          setModelParams(model.model_id, defaults);
        });
      } catch (error) {
        console.error('Failed to fetch models from backend:', error);
        setBackendAvailable(false);
      }
    };

    fetchModels();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeSegmentationState(state => {
      setActiveModelState(state.activeModel);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (evt: PointerEvent) => {
      if (!containerRef.current?.contains(evt.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!moreMenuOpen) return;

    const handlePointerDown = (evt: PointerEvent) => {
      if (!moreMenuRef.current?.contains(evt.target as Node)) {
        setMoreMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [moreMenuOpen]);

  const handleModelChange = (modelValue: string) => {
    setActiveModel(modelValue as ModelType);
    setOpen(false);
    setMoreMenuOpen(false);

    if (modelValue === 'manual') {
      // Activate ManualContour tool
      try {
        if (toolGroupService) {
          toolGroupService.setToolActive('default', 'ManualContour', { mouseButton: 1 });
        }
      } catch (e) {
        console.warn('Failed to activate ManualContour tool:', e);
      }
      return;
    }

    // Check if it's a backend model
    const isBackendModel = modelOptions.find(opt => opt.value === modelValue)?.backendModel;
    if (isBackendModel) {
      // Backend model selected
      try {
        if (toolGroupService) {
          toolGroupService.setToolActive('default', 'MaskContour', { mouseButton: 1 });
        }
      } catch (e) {
        console.warn('Failed to activate MaskContour tool:', e);
      }
      uiNotificationService?.show?.({
        title: 'Backend Model',
        message: 'Draw a mask contour (optional for no-mask mode), then click Recompute to run backend segmentation.',
        type: 'info',
        duration: 3000,
      });
    }
  };

  const handleRecompute = async () => {
    if (activeModel === 'manual') {
      // Manual doesn't need recompute
      return;
    }

    // Backend model - pass to recompute handler
    await onRecompute?.();
  };

  const handleConfigClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // Find the backend model info for active model
    const activeOption = modelOptions.find(m => m.value === activeModel);

    if (activeOption?.backendModel) {
      setSelectedModelInfo(activeOption.backendModel);
      setConfigModalOpen(true);
    }
  };

  const handleSaveConfig = (params: Record<string, any>) => {
    if (selectedModelInfo) {
      setModelParams(selectedModelInfo.model_id, params);
    }
  };

  const getActiveModelParams = (): Record<string, any> => {
    const activeOption = modelOptions.find(m => m.value === activeModel);
    if (activeOption?.backendModel) {
      return getModelParams(activeOption.backendModel.model_id);
    }
    return {};
  };

  const activeOption = modelOptions.find(m => m.value === activeModel) || modelOptions[0];

  const showRecompute = activeModel !== 'manual' && activeOption?.available !== false;
  const showConfig = activeOption?.backendModel !== undefined && activeOption?.available !== false;

  return (
    <>
      <div className="flex flex-col gap-2">
        {/* Model Dropdown + More Menu */}
        <div className="flex gap-1">
          <div ref={containerRef} className="relative flex-1">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
              onClick={() => {
                setMoreMenuOpen(false);
                setOpen(prev => !prev);
              }}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label="Select segmentation model"
            >
              <span className="truncate">{activeOption.label}</span>
              <svg
                className="h-3 w-3 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {open && (
              <div className="absolute left-0 top-full z-10 mt-1 w-full rounded border border-gray-700 bg-gray-900 p-1 text-xs text-gray-200 shadow-lg">
                {modelOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    className={`flex w-full items-center justify-between rounded px-3 py-1.5 text-left ${
                      option.value === activeModel
                        ? 'bg-gray-700'
                        : option.available
                          ? 'hover:bg-gray-800'
                          : 'cursor-not-allowed'
                    } ${!option.available ? 'opacity-50 text-gray-500' : ''}`}
                    onClick={() => option.available && handleModelChange(option.value)}
                    disabled={!option.available}
                    role="option"
                    aria-selected={option.value === activeModel}
                    aria-disabled={!option.available}
                    title={
                      !option.available && option.backendModel?.hardware_status
                        ? option.backendModel.hardware_status
                        : undefined
                    }
                  >
                    <span className="truncate">{option.label}</span>
                    <div className="ml-2 flex flex-shrink-0 gap-1">
                      {!option.available && (
                        <span className="text-[10px] text-red-400">⚠</span>
                      )}
                      {option.backendModel?.hardware_requirements?.optimal_on === 'cuda_gpu' && (
                        <span className={`text-[10px] ${option.available ? 'text-green-400' : 'text-gray-600'}`}>
                          GPU
                        </span>
                      )}
                      {option.backendModel?.hardware_requirements?.optimal_on === 'cpu' && (
                        <span className={`text-[10px] ${option.available ? 'text-blue-400' : 'text-gray-600'}`}>
                          CPU
                        </span>
                      )}
                      {option.backendModel?.hardware_requirements?.optimal_on === 'tpu' && (
                        <span className={`text-[10px] ${option.available ? 'text-purple-400' : 'text-gray-600'}`}>
                          TPU
                        </span>
                      )}
                      {option.backendModel?.hardware_requirements?.optimal_on === 'apple_mps' && (
                        <span className={`text-[10px] ${option.available ? 'text-orange-400' : 'text-gray-600'}`}>
                          MPS
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Three-dot more menu */}
          <div ref={moreMenuRef} className="relative">
            <button
              type="button"
              className="flex items-center justify-center rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              aria-label="More options"
              onClick={() => {
                setOpen(false);
                setMoreMenuOpen(prev => !prev);
              }}
            >
              <svg
                className="h-3 w-3"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
              </svg>
            </button>

            {moreMenuOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 min-w-[140px] rounded border border-gray-700 bg-gray-900 p-1 text-xs text-gray-200 shadow-lg">
                {showConfig && (
                  <>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left hover:bg-gray-800"
                      onClick={e => {
                        handleConfigClick(e);
                        setMoreMenuOpen(false);
                      }}
                    >
                      Configure
                    </button>
                    <hr className="my-1 border-gray-700" />
                  </>
                )}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left hover:bg-gray-800"
                  onClick={() => {
                    onExportNifti?.('label');
                    setMoreMenuOpen(false);
                  }}
                >
                  NIfTI SEG
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left hover:bg-gray-800"
                  onClick={() => {
                    onExportNifti?.('both');
                    setMoreMenuOpen(false);
                  }}
                >
                  NIfTI IMG+SEG
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Backend Status Indicator */}
        {!backendAvailable && (
          <div className="rounded bg-yellow-900/20 px-2 py-1 text-center text-[10px] text-yellow-500">
            ⚠ Backend unavailable - only Manual mode is available
          </div>
        )}

        {/* Recompute Button */}
        {showRecompute && (
          <button
            type="button"
            onClick={handleRecompute}
            className="flex w-full items-center justify-center gap-1 rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            title="Recompute segmentation"
            disabled={isRecomputing}
          >
            <svg
              className={`h-3 w-3 ${isRecomputing ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            <span>{isRecomputing ? 'Running...' : 'Recompute'}</span>
          </button>
        )}

        {isRecomputing && (
          <div className="rounded bg-blue-900/20 px-2 py-1 text-center text-[10px] text-blue-400">
            {recomputeStatusText || 'Awaiting segmentation result...'}
          </div>
        )}
      </div>

      {/* Configuration Modal */}
      <SegmentationConfigModal
        isOpen={configModalOpen}
        onClose={() => setConfigModalOpen(false)}
        modelInfo={selectedModelInfo}
        currentParams={getActiveModelParams()}
        onSave={handleSaveConfig}
      />
    </>
  );
};

export default SegmentationModelSelector;
