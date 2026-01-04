import React, { useState, useEffect, useRef } from 'react';
import { ModelType, getSegmentationState, setActiveModel, subscribeSegmentationState } from '../../utils/segmentationStore';

interface SegmentationModelSelectorProps {
  commandsManager?: any;
  servicesManager?: any;
  onRecompute?: () => void;
}

type ModelOption = {
  value: ModelType;
  label: string;
  available: boolean;
};

const MODEL_OPTIONS: ModelOption[] = [
  { value: 'manual', label: 'Manual', available: true },
  { value: 'threshold', label: 'Threshold-Otsu', available: true },
  { value: 'medsam', label: 'MedSAM', available: false },
  { value: 'unet_uterine', label: 'UNet-Uterine', available: false },
];

const SegmentationModelSelector: React.FC<SegmentationModelSelectorProps> = ({
  commandsManager,
  servicesManager,
  onRecompute,
}) => {
  const [activeModel, setActiveModelState] = useState<ModelType>(getSegmentationState().activeModel);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const uiNotificationService = servicesManager?.services?.uiNotificationService;
  const toolGroupService = servicesManager?.services?.toolGroupService;

  useEffect(() => {
    const unsubscribe = subscribeSegmentationState(state => {
      setActiveModelState(state.activeModel);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!open) return;

    const handleClick = (evt: MouseEvent) => {
      if (!containerRef.current?.contains(evt.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleModelChange = (model: ModelType) => {
    setActiveModel(model);
    setOpen(false);

    if (model === 'manual') {
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

    if (model === 'threshold') {
      // Activate MaskContour tool for Otsu boundary
      try {
        if (toolGroupService) {
          toolGroupService.setToolActive('default', 'MaskContour', { mouseButton: 1 });
        }
      } catch (e) {
        console.warn('Failed to activate MaskContour tool:', e);
      }
      uiNotificationService?.show?.({
        title: 'Threshold-Otsu',
        message: 'Draw a mask contour first, then click Recompute to run Otsu segmentation.',
        type: 'info',
        duration: 3000,
      });
      return;
    }

    // Show notification for stub models
    uiNotificationService?.show?.({
      title: 'Segmentation Model',
      message: `${MODEL_OPTIONS.find(m => m.value === model)?.label || model} model coming in Task 4.1.3`,
      type: 'info',
      duration: 3000,
    });
  };

  const handleRecompute = () => {
    if (activeModel === 'manual') {
      // Manual doesn't need recompute
      return;
    }

    if (activeModel === 'threshold') {
      onRecompute?.();
      return;
    }

    uiNotificationService?.show?.({
      title: 'Recompute',
      message: 'Backend segmentation integration coming in Task 4.1.3',
      type: 'info',
      duration: 3000,
    });
  };

  const activeOption = MODEL_OPTIONS.find(m => m.value === activeModel) || MODEL_OPTIONS[0];
  const showRecompute = activeModel !== 'manual';

  return (
    <div className="flex flex-col gap-2">
      {/* Model Dropdown */}
      <div ref={containerRef} className="relative">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
          onClick={() => setOpen(prev => !prev)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Select segmentation model"
        >
          <span>{activeOption.label}</span>
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
          <div className="absolute left-0 z-10 mt-1 w-full rounded border border-gray-700 bg-gray-900 p-1 text-xs text-gray-200 shadow-lg">
            {MODEL_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                className={`flex w-full items-center justify-between rounded px-3 py-1.5 text-left ${
                  option.value === activeModel
                    ? 'bg-gray-700'
                    : 'hover:bg-gray-800'
                } ${!option.available && option.value !== 'manual' ? 'text-gray-500' : ''}`}
                onClick={() => handleModelChange(option.value)}
                role="option"
                aria-selected={option.value === activeModel}
              >
                <span>{option.label}</span>
                {!option.available && option.value !== 'manual' && (
                  <span className="text-[10px] text-gray-500">Coming soon</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Recompute Button */}
      {showRecompute && (
        <button
          type="button"
          onClick={handleRecompute}
          className="flex w-full items-center justify-center gap-1 rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
          title="Recompute segmentation"
        >
          <svg
            className="h-3 w-3"
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
          <span>Recompute</span>
        </button>
      )}
    </div>
  );
};

export default SegmentationModelSelector;
