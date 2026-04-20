import React, { useEffect, useState } from 'react';
import { DialogTitle, Numeric } from '@ohif/ui-next';

const OVI_CANVAS_SCALE_EVENT = 'ovi-canvas-scale-change';

type ManualContourLabelMenuProps = {
  labelData: { label: string; value: string; color: string }[];
  initialLabel?: string;
  onSelect: (value: string) => void;
  brushSize?: number;
  canvasPxPerMm?: number | null;
  showBrushSizeControl?: boolean;
  onBrushSizeChange?: (value: number) => void;
  hide?: () => void;
};

const ManualContourLabelMenu: React.FC<ManualContourLabelMenuProps> = ({
  labelData,
  initialLabel,
  onSelect,
  brushSize = 3,
  canvasPxPerMm: initialCanvasPxPerMm = null,
  showBrushSizeControl = false,
  onBrushSizeChange,
  hide,
}) => {
  const [localBrushSize, setLocalBrushSize] = useState(brushSize);
  const [canvasPxPerMm, setCanvasPxPerMm] = useState<number | null>(initialCanvasPxPerMm);

  useEffect(() => {
    setLocalBrushSize(brushSize);
  }, [brushSize]);

  useEffect(() => {
    const handler = (e: Event) => {
      const newScale = (e as CustomEvent).detail?.canvasPxPerMm;
      if (typeof newScale === 'number') {
        setCanvasPxPerMm(newScale);
      }
    };
    window.addEventListener(OVI_CANVAS_SCALE_EVENT, handler);
    return () => window.removeEventListener(OVI_CANVAS_SCALE_EVENT, handler);
  }, []);

  const handleSelect = (value: string) => {
    onSelect(value);
    if (hide) {
      hide();
    }
  };

  const updateBrushSize = (nextValue: number) => {
    const clamped = Math.min(99.5, Math.max(0.5, Number(nextValue) || 3));
    setLocalBrushSize(clamped);
    onBrushSizeChange?.(clamped);
  };

  const getForegroundColor = (color: string) => {
    const hex = color.replace('#', '');
    if (hex.length !== 6) {
      return '#0F172A';
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.68 ? '#0F172A' : '#F8FAFC';
  };

  const activeColor = labelData.find(d => d.value === initialLabel)?.color ?? '#FFFFFF';
  // Diameter in canvas pixels (matches the cursor on the viewport exactly).
  // Falls back to CSS mm when the scale is not yet known.
  const circlePx = canvasPxPerMm !== null ? Math.max(8, localBrushSize * 2 * canvasPxPerMm) : null;
  const circleSize = circlePx !== null ? circlePx : `${localBrushSize * 2}mm`;

  return (
    <div className="relative w-64 rounded-md border border-input bg-popover p-1 text-popover-foreground shadow-md">
      {showBrushSizeControl && (
        <div
          className="pointer-events-none absolute flex items-center justify-center"
          style={{
            width: circleSize,
            height: circleSize,
            right: `calc(100% + 8px)`,
            top: 8,
          }}
        >
          <div
            style={{
              width: circleSize,
              height: circleSize,
              flexShrink: 0,
              borderRadius: '50%',
              border: `2px solid ${activeColor}`,
              backgroundColor: 'transparent',
            }}
          />
        </div>
      )}
      <style>{`
        .manual-contour-radius-slider > span:last-of-type > [role='slider'] {
          border-color: hsl(var(--input)) !important;
        }
      `}</style>
      <DialogTitle className="sr-only">Annotation label</DialogTitle>
      {showBrushSizeControl ? (
        <div className="mb-2 rounded-sm border border-border/80 px-2 py-2">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Radius (mm)</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="border-input bg-background hover:bg-accent hover:text-accent-foreground h-7 w-7 rounded border text-base leading-none"
              onClick={() => updateBrushSize(localBrushSize - 0.5)}
            >
              -
            </button>
            <Numeric.Container
              mode="singleRange"
              value={localBrushSize}
              onChange={v => updateBrushSize(typeof v === 'number' ? v : (v as number[])[0])}
              min={0.5}
              max={99.5}
              step={0.5}
              className="flex min-w-0 flex-1 flex-row items-center space-x-2"
            >
              <Numeric.SingleRange
                showNumberInput={true}
                sliderClassName="manual-contour-radius-slider"
              />
            </Numeric.Container>
            <button
              type="button"
              className="border-input bg-background hover:bg-accent hover:text-accent-foreground h-7 w-7 rounded border text-base leading-none"
              onClick={() => updateBrushSize(localBrushSize + 0.5)}
            >
              +
            </button>
          </div>
        </div>
      ) : null}
      {labelData.map(item => {
        const color = item.color || '#FFFFFF';
        const isSelected = item.value === initialLabel;
        const foregroundColor = getForegroundColor(color);

        return (
          <button
            key={item.value}
            type="button"
            onClick={() => handleSelect(item.value)}
            className="relative mb-1 flex w-full cursor-pointer select-none items-center rounded-sm border px-3 py-2 text-sm outline-none last:mb-0"
            style={{
              borderColor: color,
              backgroundColor: isSelected ? color : 'transparent',
              color: isSelected ? foregroundColor : color,
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
};

export default ManualContourLabelMenu;
