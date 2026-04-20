import React, { useState, useEffect } from 'react';
import {
  setSegmentationBackendUrl,
  getSegmentationBackendUrl,
  resetSegmentationBackendUrl,
} from '../services/segmentationApi';

interface PreferencesPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * OVI Labs Preferences Panel
 *
 * Allows users to configure:
 * - Segmentation backend URL
 */
const PreferencesPanel: React.FC<PreferencesPanelProps> = ({ isOpen, onClose }) => {
  const [backendUrl, setBackendUrl] = useState(getSegmentationBackendUrl());
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setBackendUrl(getSegmentationBackendUrl());
    }
  }, [isOpen]);

  const handleSave = () => {
    setSegmentationBackendUrl(backendUrl);
    localStorage.setItem('ovi-labs-backend-url', backendUrl);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 1000);
  };

  const handleReset = () => {
    resetSegmentationBackendUrl();
    setBackendUrl(getSegmentationBackendUrl());
    localStorage.removeItem('ovi-labs-backend-url');
  };

  const handleCancel = () => {
    setBackendUrl(getSegmentationBackendUrl()); // Revert changes
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-full max-w-lg rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <h3 className="text-lg font-medium text-gray-100">OVI Labs Preferences</h3>
          <button
            onClick={handleCancel}
            className="text-gray-400 hover:text-gray-200"
            title="Close"
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

        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-300">
              Segmentation Backend URL
            </label>
            <input
              type="url"
              value={backendUrl}
              onChange={e => setBackendUrl(e.target.value)}
              placeholder="http://localhost:8000"
              className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-500">
              URL of the MedEx segmentation backend API (default: http://localhost:8000)
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={handleReset}
            className="rounded border border-gray-600 bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
          >
            Reset to Default
          </button>
          <button
            onClick={handleCancel}
            className="rounded border border-gray-600 bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className={`rounded px-4 py-2 text-sm text-white ${
              saved
                ? 'bg-green-600'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
            disabled={saved}
          >
            {saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PreferencesPanel;
