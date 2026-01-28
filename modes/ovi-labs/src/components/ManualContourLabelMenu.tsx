import React from 'react';
import { DialogTitle } from '@ohif/ui-next';

type ManualContourLabelMenuProps = {
  labelData: { label: string; value: string }[];
  initialLabel?: string;
  onSelect: (value: string) => void;
  hide?: () => void;
};

const SEGMENTATION_COLORS: Record<string, string> = {
  uterineCavity: '#22D3EE',
  endometrium: '#F472B6',
  myometrium: '#FBBF24',
  junctionalZone: '#60A5FA',
};

const ManualContourLabelMenu: React.FC<ManualContourLabelMenuProps> = ({
  labelData,
  initialLabel,
  onSelect,
  hide,
}) => {
  const handleSelect = (value: string) => {
    onSelect(value);
    if (hide) {
      hide();
    }
  };

  return (
    <div className="w-48 overflow-hidden rounded-md border border-input bg-popover p-1 text-popover-foreground shadow-md">
      <DialogTitle className="sr-only">Manual contour label</DialogTitle>
      {labelData.map(item => {
        const color = SEGMENTATION_COLORS[item.value] || '#FFFFFF';
        const isSelected = item.value === initialLabel;

        return (
          <button
            key={item.value}
            type="button"
            onClick={() => handleSelect(item.value)}
            className={`relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none ${
              isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
            }`}
          >
            <svg
              className={`mr-2 h-4 w-4 flex-shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0'}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              style={{ color }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
            <span style={{ color }}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export default ManualContourLabelMenu;
