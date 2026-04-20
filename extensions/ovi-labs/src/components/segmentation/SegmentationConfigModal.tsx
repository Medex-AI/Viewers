import React, { useState, useEffect } from 'react';
import { ModelInfo } from '../../services/segmentationApi';

interface SegmentationConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  modelInfo: ModelInfo | null;
  currentParams: Record<string, any>;
  onSave: (params: Record<string, any>) => void;
}

/**
 * Modal for configuring segmentation model parameters
 *
 * Auto-discovers parameters from model's params_schema and
 * renders appropriate UI controls for each parameter type.
 *
 * Sprint 3.2b: Dynamic model parameter UI
 */
const SegmentationConfigModal: React.FC<SegmentationConfigModalProps> = ({
  isOpen,
  onClose,
  modelInfo,
  currentParams,
  onSave,
}) => {
  const [params, setParams] = useState<Record<string, any>>(currentParams);

  useEffect(() => {
    setParams(currentParams);
  }, [currentParams, isOpen]);

  if (!isOpen || !modelInfo) return null;

  const schema = modelInfo.params_schema;
  const properties = schema?.properties || {};

  const handleSave = () => {
    onSave(params);
    onClose();
  };

  const handleReset = () => {
    // Reset to default values from schema
    const defaults: Record<string, any> = {};
    Object.entries(properties).forEach(([key, prop]: [string, any]) => {
      if (prop.default !== undefined) {
        defaults[key] = prop.default;
      }
    });
    setParams(defaults);
  };

  const renderParameterInput = (key: string, prop: any) => {
    const value = params[key] ?? prop.default;

    // Enum/Select dropdown
    if (prop.enum && Array.isArray(prop.enum)) {
      return (
        <select
          value={value || ''}
          onChange={(e) => setParams({ ...params, [key]: e.target.value })}
          className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-xs text-gray-200"
        >
          {prop.enum.map((option: string) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    // Boolean checkbox
    if (prop.type === 'boolean') {
      return (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value || false}
            onChange={(e) => setParams({ ...params, [key]: e.target.checked })}
            className="h-4 w-4"
          />
          <span className="text-xs text-gray-300">
            {value ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      );
    }

    // Number input (integer or float)
    if (prop.type === 'number' || prop.type === 'integer') {
      return (
        <div className="flex flex-col gap-1">
          <input
            type="number"
            value={value ?? ''}
            min={prop.minimum}
            max={prop.maximum}
            step={prop.type === 'integer' ? 1 : 0.1}
            onChange={(e) => {
              const val = prop.type === 'integer'
                ? parseInt(e.target.value, 10)
                : parseFloat(e.target.value);
              setParams({ ...params, [key]: isNaN(val) ? prop.default : val });
            }}
            className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-xs text-gray-200"
          />
          {(prop.minimum !== undefined || prop.maximum !== undefined) && (
            <span className="text-[10px] text-gray-500">
              Range: {prop.minimum ?? '−∞'} to {prop.maximum ?? '∞'}
            </span>
          )}
        </div>
      );
    }

    // String input
    if (prop.type === 'string') {
      return (
        <input
          type="text"
          value={value || ''}
          onChange={(e) => setParams({ ...params, [key]: e.target.value })}
          className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-xs text-gray-200"
        />
      );
    }

    // Fallback for unsupported types
    return (
      <span className="text-xs text-gray-500">
        Unsupported type: {prop.type}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="relative w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-medium text-gray-100">
              {modelInfo.name}
            </h3>
            <p className="mt-1 text-xs text-gray-400">
              Configure model parameters
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
            aria-label="Close"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Parameter List */}
        <div className="mb-6 max-h-96 space-y-4 overflow-y-auto">
          {Object.keys(properties).length === 0 ? (
            <p className="text-xs text-gray-500">
              No configurable parameters for this model.
            </p>
          ) : (
            Object.entries(properties).map(([key, prop]: [string, any]) => (
              <div key={key} className="space-y-1">
                <label className="block text-sm font-medium text-gray-300">
                  {key}
                  {prop.default !== undefined && (
                    <span className="ml-2 text-xs text-gray-500">
                      (default: {JSON.stringify(prop.default)})
                    </span>
                  )}
                </label>
                {prop.description && (
                  <p className="text-xs text-gray-500">{prop.description}</p>
                )}
                {renderParameterInput(key, prop)}
              </div>
            ))
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={handleReset}
            className="rounded border border-gray-600 bg-gray-800 px-4 py-2 text-xs text-gray-300 hover:bg-gray-700"
          >
            Reset to Defaults
          </button>
          <button
            onClick={onClose}
            className="rounded border border-gray-600 bg-gray-800 px-4 py-2 text-xs text-gray-300 hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="rounded bg-blue-600 px-4 py-2 text-xs text-white hover:bg-blue-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default SegmentationConfigModal;
