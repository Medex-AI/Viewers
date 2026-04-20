import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getRoiAnalysisData,
  subscribeRoiAnalysisData,
} from '../utils/roiAnalysisDataStore';
import {
  getKymographSettings,
  setKymographSettings,
} from '../utils/kymographSettingsStore';
import {
  getFrameRate,
  getFrameRateSource,
  setFrameRate,
  subscribeFrameRate,
} from '../utils/frameRateStore';

interface KymographsPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

/**
 * Kymographs Panel - Placeholder
 *
 * Future features:
 * - X-t and Y-t kymograph visualization
 * - Colormap selection
 * - Axis selection (major/minor)
 * - Export kymograph image
 */
const COLORMAP_OPTIONS = [
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'plasma', label: 'Plasma' },
  { value: 'inferno', label: 'Inferno' },
  { value: 'magma', label: 'Magma' },
  { value: 'cividis', label: 'Cividis' },
];

const SPATIAL_AXIS_OPTIONS = [
  { value: 'major', label: 'Major axis' },
  { value: 'minor', label: 'Minor axis' },
];

const COLORMAP_STOPS: Record<string, Array<[number, number, number]>> = {
  grayscale: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  viridis: [
    [0.267, 0.005, 0.329],
    [0.283, 0.141, 0.458],
    [0.254, 0.265, 0.53],
    [0.207, 0.372, 0.553],
    [0.164, 0.471, 0.558],
    [0.128, 0.567, 0.551],
    [0.135, 0.659, 0.518],
    [0.267, 0.749, 0.441],
    [0.478, 0.821, 0.318],
    [0.741, 0.873, 0.15],
  ],
  plasma: [
    [0.05, 0.03, 0.527],
    [0.243, 0.017, 0.656],
    [0.404, 0.09, 0.693],
    [0.557, 0.167, 0.657],
    [0.698, 0.253, 0.57],
    [0.825, 0.348, 0.459],
    [0.929, 0.455, 0.353],
    [0.984, 0.573, 0.258],
    [0.995, 0.707, 0.187],
    [0.94, 0.87, 0.149],
  ],
  inferno: [
    [0.002, 0.005, 0.013],
    [0.14, 0.047, 0.27],
    [0.276, 0.081, 0.396],
    [0.414, 0.114, 0.454],
    [0.553, 0.147, 0.437],
    [0.686, 0.196, 0.369],
    [0.804, 0.275, 0.267],
    [0.902, 0.39, 0.198],
    [0.964, 0.569, 0.216],
    [0.988, 0.799, 0.365],
  ],
  magma: [
    [0.001, 0, 0.015],
    [0.098, 0.027, 0.157],
    [0.212, 0.06, 0.271],
    [0.343, 0.092, 0.355],
    [0.48, 0.124, 0.392],
    [0.616, 0.164, 0.394],
    [0.746, 0.225, 0.379],
    [0.863, 0.31, 0.353],
    [0.945, 0.46, 0.327],
    [0.987, 0.716, 0.45],
  ],
  cividis: [
    [0, 0.135, 0.304],
    [0.063, 0.204, 0.431],
    [0.145, 0.286, 0.509],
    [0.251, 0.367, 0.533],
    [0.361, 0.45, 0.51],
    [0.473, 0.533, 0.458],
    [0.589, 0.616, 0.39],
    [0.706, 0.698, 0.32],
    [0.823, 0.78, 0.255],
    [0.94, 0.862, 0.2],
  ],
};

const sampleColormap = (name: string, value: number) => {
  const stops = COLORMAP_STOPS[name] || COLORMAP_STOPS.grayscale;
  const clamped = Math.min(1, Math.max(0, value));
  const scaled = clamped * (stops.length - 1);
  const index = Math.floor(scaled);
  const t = scaled - index;
  const [r1, g1, b1] = stops[index];
  const [r2, g2, b2] = stops[Math.min(index + 1, stops.length - 1)];
  return [
    Math.round((r1 + (r2 - r1) * t) * 255),
    Math.round((g1 + (g2 - g1) * t) * 255),
    Math.round((b1 + (b2 - b1) * t) * 255),
  ];
};

const colormapGradient = (name: string) => {
  const stops = COLORMAP_STOPS[name] || COLORMAP_STOPS.grayscale;
  const segments = stops
    .map((stop, index) => {
      const percent = Math.round((index / (stops.length - 1)) * 100);
      const [r, g, b] = stop.map(channel => Math.round(channel * 255));
      return `rgb(${r}, ${g}, ${b}) ${percent}%`;
    })
    .join(', ');
  return `linear-gradient(90deg, ${segments})`;
};

type DropdownOption = { value: string; label: string };

interface DropdownProps {
  ariaLabel: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  renderPreview?: (value: string) => React.ReactNode;
  className?: string;
}

const Dropdown: React.FC<DropdownProps> = ({
  ariaLabel,
  value,
  options,
  onChange,
  renderPreview,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeOption = options.find(option => option.value === value) || options[0];

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (evt: PointerEvent) => {
      if (!containerRef.current?.contains(evt.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  if (!activeOption) {
    return null;
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className={`flex items-center justify-between gap-2 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-200 ${className || ''}`}
        onClick={() => setOpen(prev => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <div className="flex items-center gap-2">
          {renderPreview ? renderPreview(activeOption.value) : null}
          <span>{activeOption.label}</span>
        </div>
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
      {open ? (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded border border-gray-700 bg-gray-900 p-1 text-[11px] text-gray-200 shadow-lg">
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-800"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              role="option"
              aria-selected={option.value === value}
            >
              {renderPreview ? renderPreview(option.value) : null}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

type TimeAxisFormat = 's' | 'mm:ss' | 'hh:mm:ss';

const resolveTimeAxisFormat = (durationSeconds: number): TimeAxisFormat => {
  if (durationSeconds >= 3600) {
    return 'hh:mm:ss';
  }
  if (durationSeconds >= 60) {
    return 'mm:ss';
  }
  return 's';
};

const padTwo = (value: number) => value.toString().padStart(2, '0');

const formatTimeLabel = (seconds: number, format: TimeAxisFormat) => {
  if (format === 's') {
    if (seconds < 10) {
      return seconds.toFixed(2);
    }
    if (seconds < 100) {
      return seconds.toFixed(1);
    }
    return seconds.toFixed(0);
  }

  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (format === 'hh:mm:ss') {
    return `${padTwo(hours)}:${padTwo(minutes)}:${padTwo(secs)}`;
  }

  return `${padTwo(minutes)}:${padTwo(secs)}`;
};

const timeAxisLabel = (format: TimeAxisFormat) => {
  if (format === 'mm:ss') {
    return 'Time (mm:ss)';
  }
  if (format === 'hh:mm:ss') {
    return 'Time (hh:mm:ss)';
  }
  return 'Time (s)';
};

const KymographsPanel: React.FC<KymographsPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  const initialSettings = getKymographSettings();
  const [selectedColormap, setSelectedColormap] = useState(initialSettings.colormap);
  const [spatialAxis, setSpatialAxis] = useState<'major' | 'minor'>(initialSettings.spatialAxis);
  const [showProfileLine, setShowProfileLine] = useState(initialSettings.showProfileLine);
  const [analysisData, setAnalysisData] = useState(getRoiAnalysisData());
  const [frameRateValue, setFrameRateValue] = useState(getFrameRate());
  const [frameRateInput, setFrameRateInput] = useState(getFrameRate().toString());
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    frameNumber: number;
    timeSeconds: number;
  } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<{
    leftMargin: number;
    topMargin: number;
    imageWidth: number;
    imageHeight: number;
    timeCount: number;
    frameTimeMs: number;
    containerWidth: number;
    containerHeight: number;
  } | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeRoiAnalysisData(nextData => {
      setAnalysisData(nextData);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeFrameRate(value => {
      setFrameRateValue(value);
      setFrameRateInput(value.toString());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    setKymographSettings({ spatialAxis, colormap: selectedColormap, showProfileLine });
  }, [spatialAxis, selectedColormap, showProfileLine]);

  const axisOption =
    SPATIAL_AXIS_OPTIONS.find(option => option.value === spatialAxis) ||
    SPATIAL_AXIS_OPTIONS[0];
  const colormapOption =
    COLORMAP_OPTIONS.find(option => option.value === selectedColormap) ||
    COLORMAP_OPTIONS[0];

  const kymograph = useMemo(() => {
    if (!analysisData?.frames?.length) {
      return null;
    }

    const { frames, width, height } = analysisData;
    const timeCount = frames.length;
    const axisForData = (() => {
      if (spatialAxis === 'major') {
        return width >= height ? 'x' : 'y';
      }
      if (spatialAxis === 'minor') {
        return width >= height ? 'y' : 'x';
      }
      return spatialAxis;
    })();
    const spatialLength = axisForData === 'y' ? height : width;
    const matrix = new Float32Array(timeCount * spatialLength);
    let min = Infinity;
    let max = -Infinity;

    frames.forEach((frame, frameIndex) => {
      if (!frame?.length) {
        return;
      }

      if (axisForData === 'y') {
        for (let row = 0; row < height; row += 1) {
          let sum = 0;
          const rowOffset = row * width;
          for (let col = 0; col < width; col += 1) {
            sum += frame[rowOffset + col];
          }
          const value = sum / width;
          const index = frameIndex * spatialLength + row;
          matrix[index] = value;
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      } else {
        for (let col = 0; col < width; col += 1) {
          let sum = 0;
          for (let row = 0; row < height; row += 1) {
            sum += frame[row * width + col];
          }
          const value = sum / height;
          const index = frameIndex * spatialLength + col;
          matrix[index] = value;
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    });

    return {
      matrix,
      timeCount,
      spatialLength,
      min,
      max,
      axis: axisForData,
    };
  }, [analysisData, spatialAxis]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !kymograph) {
      return;
    }

    const { matrix, timeCount, spatialLength, min, max, axis } = kymograph;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const spacing = analysisData?.spacing;
    const hasSpacing =
      spacing &&
      typeof spacing.row === 'number' &&
      typeof spacing.column === 'number' &&
      spacing.row > 0 &&
      spacing.column > 0;

    const spatialSpacing = axis === 'y' ? spacing?.row : spacing?.column;
    const spatialUnitLength = hasSpacing && spatialSpacing ? spatialLength * spatialSpacing : spatialLength;
    const spatialUnitLabel = hasSpacing ? 'mm' : 'px';

    const MEDEX_ORANGE = '#F47620';
    const leftMargin = 50;
    const topMargin = 10;
    const rightMargin = 10;
    const bottomMargin = 40;

    const dpr = window.devicePixelRatio || 1;
    const containerWidth = canvas.clientWidth || timeCount;
    const containerHeight = canvas.clientHeight || spatialLength;
    const imageWidth = containerWidth - leftMargin - rightMargin;
    const imageHeight = containerHeight - topMargin - bottomMargin;

    canvas.width = Math.round(containerWidth * dpr);
    canvas.height = Math.round(containerHeight * dpr);
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, containerWidth, containerHeight);

    const imageData = ctx.createImageData(timeCount, spatialLength);
    const range = max - min || 1;

    for (let y = 0; y < spatialLength; y += 1) {
      for (let x = 0; x < timeCount; x += 1) {
        const value = matrix[x * spatialLength + y];
        const normalized = (value - min) / range;
        const [r, g, b] = sampleColormap(selectedColormap, normalized);
        const index = (y * timeCount + x) * 4;
        imageData.data[index] = r;
        imageData.data[index + 1] = g;
        imageData.data[index + 2] = b;
        imageData.data[index + 3] = 255;
      }
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = timeCount;
    tempCanvas.height = spatialLength;
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      tempCtx.putImageData(imageData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tempCanvas, leftMargin, topMargin, imageWidth, imageHeight);
    }

    const targetTicks = 5;

    const calculateTickSpacing = (maxUnits: number) => {
      const rawStep = maxUnits > 0 ? maxUnits / targetTicks : 10;
      const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
      const baseSteps = [1, 2, 5, 10];
      for (const base of baseSteps) {
        const candidate = base * magnitude;
        if (candidate >= rawStep) {
          return candidate;
        }
      }
      return baseSteps[baseSteps.length - 1] * magnitude;
    };

    const frameSource = getFrameRateSource();
    const frameTimeMs =
      frameSource === 'manual' && frameRateValue > 0
        ? 1000 / frameRateValue
        : analysisData?.frameTimeMs || (frameRateValue > 0 ? 1000 / frameRateValue : 0);
    const durationSeconds = frameTimeMs > 0 ? (timeCount * frameTimeMs) / 1000 : timeCount;
    const axisFormat = resolveTimeAxisFormat(durationSeconds);
    const tickEveryTimeUnit = calculateTickSpacing(durationSeconds);
    const tickEveryTimePixel =
      durationSeconds > 0 ? (tickEveryTimeUnit / durationSeconds) * imageWidth : 0;

    const tickEverySpatialUnit = calculateTickSpacing(spatialUnitLength);
    const tickEverySpatialPixel = (tickEverySpatialUnit / spatialUnitLength) * imageHeight;

    const tickLength = 6;
    const labelOffset = 3;
    const fontSize = 10;

    ctx.strokeStyle = MEDEX_ORANGE;
    ctx.fillStyle = MEDEX_ORANGE;
    ctx.lineWidth = 1;
    ctx.font = `${fontSize}px Arial, Helvetica, sans-serif`;

    if (tickEveryTimePixel > 6) {
      let tickIndex = 0;
      const bottomY = topMargin + imageHeight;
      for (let x = leftMargin; x <= leftMargin + imageWidth + 0.5; x += tickEveryTimePixel) {
        const labelValue = tickIndex * tickEveryTimeUnit;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.beginPath();
        ctx.moveTo(x, bottomY);
        ctx.lineTo(x, bottomY + tickLength);
        ctx.stroke();
        if (tickIndex !== 0) {
          ctx.fillText(formatTimeLabel(labelValue, axisFormat), x, bottomY + tickLength + labelOffset);
        }
        tickIndex += 1;
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(timeAxisLabel(axisFormat), containerWidth / 2, containerHeight - 2);
    }

    if (tickEverySpatialPixel > 6) {
      let tickIndex = 0;
      for (let y = topMargin; y <= topMargin + imageHeight + 0.5; y += tickEverySpatialPixel) {
        const labelValue = Math.round(tickIndex * tickEverySpatialUnit);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.beginPath();
        ctx.moveTo(leftMargin, y);
        ctx.lineTo(leftMargin - tickLength, y);
        ctx.stroke();
        if (tickIndex !== 0) {
          ctx.fillText(`${labelValue}${spatialUnitLabel}`, leftMargin - tickLength - labelOffset, y);
        }
        tickIndex += 1;
      }
    }
    layoutRef.current = {
      leftMargin,
      topMargin,
      imageWidth,
      imageHeight,
      timeCount,
      frameTimeMs,
      containerWidth,
      containerHeight,
    };
  }, [kymograph, selectedColormap, analysisData, frameRateValue]);

    return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-black p-4 text-white">
      <div className="mb-3 flex flex-col gap-2 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Frame rate (fps)</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="h-6 w-6 rounded border border-gray-700 text-[12px] text-gray-200 hover:bg-gray-800"
              onClick={() => {
                const nextValue = Math.max(1, (Number(frameRateInput) || 1) - 1);
                const fixed = Number(nextValue.toFixed(0));
                setFrameRateInput(fixed.toString());
                setFrameRate(fixed);
              }}
              aria-label="Decrease frame rate"
            >
              -
            </button>
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              className="w-20 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-right text-[11px] text-gray-200"
              value={frameRateInput}
              onChange={evt => {
                const nextValue = evt.target.value;
                setFrameRateInput(nextValue);
                const parsed = Number(nextValue);
                if (Number.isFinite(parsed) && parsed >= 1) {
                  setFrameRate(parsed);
                }
              }}
            />
            <button
              type="button"
              className="h-6 w-6 rounded border border-gray-700 text-[12px] text-gray-200 hover:bg-gray-800"
              onClick={() => {
                const nextValue = (Number(frameRateInput) || 1) + 1;
                const fixed = Number(nextValue.toFixed(0));
                setFrameRateInput(fixed.toString());
                setFrameRate(fixed);
              }}
              aria-label="Increase frame rate"
            >
              +
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Spatial axis</span>
          <Dropdown
            ariaLabel="Spatial axis"
            value={axisOption.value}
            options={SPATIAL_AXIS_OPTIONS}
            onChange={val => setSpatialAxis(val as 'major' | 'minor')}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Colormap</span>
          <Dropdown
            ariaLabel="Colormap"
            value={colormapOption.value}
            options={COLORMAP_OPTIONS}
            onChange={setSelectedColormap}
            renderPreview={value => (
              <span
                className="h-2 w-10 rounded"
                style={{ backgroundImage: colormapGradient(value) }}
              />
            )}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Show profile line</span>
          <input
            type="checkbox"
            checked={showProfileLine}
            onChange={e => setShowProfileLine(e.target.checked)}
            className="h-4 w-4 rounded border-gray-700 bg-gray-900 text-orange-600"
          />
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center rounded bg-gray-900">
        {kymograph ? (
          <div className="flex h-full w-full flex-col">
            <div className="flex-1 p-3">
              <div className="relative h-full w-full rounded bg-black">
                <canvas
                  ref={canvasRef}
                  className="h-full w-full"
                  style={{ imageRendering: 'pixelated' }}
                  onMouseMove={event => {
                    const layout = layoutRef.current;
                    if (!layout) {
                      setHoverInfo(null);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    const x = event.clientX - rect.left;
                    const y = event.clientY - rect.top;
                    const withinX =
                      x >= layout.leftMargin && x <= layout.leftMargin + layout.imageWidth;
                    const withinY =
                      y >= layout.topMargin && y <= layout.topMargin + layout.imageHeight;
                    if (!withinX || !withinY) {
                      setHoverInfo(null);
                      return;
                    }
                    const xRatio = (x - layout.leftMargin) / layout.imageWidth;
                    const clamped = Math.min(1, Math.max(0, xRatio));
                    const frameNumber =
                      Math.round(clamped * (layout.timeCount - 1)) + 1;
                    const timeSeconds =
                      layout.frameTimeMs > 0
                        ? ((frameNumber - 1) * layout.frameTimeMs) / 1000
                        : frameNumber - 1;
                    setHoverInfo({ x, y, frameNumber, timeSeconds });
                  }}
                  onMouseLeave={() => setHoverInfo(null)}
                />
                {hoverInfo ? (
                  <div
                    className="pointer-events-none absolute rounded bg-gray-900 px-2 py-1 text-[10px] text-gray-100"
                    style={{
                      left: Math.max(
                        6,
                        Math.min(
                          hoverInfo.x + 10,
                          (layoutRef.current?.containerWidth || 0) - 120
                        )
                      ),
                      top: Math.max(
                        (layoutRef.current?.topMargin || 0) + 6,
                        hoverInfo.y - 24
                      ),
                    }}
                  >
                    Frame {hoverInfo.frameNumber} ({hoverInfo.timeSeconds.toFixed(1)}s)
                  </div>
                ) : null}
              </div>
            </div>
            <div className="border-t border-gray-800 px-3 py-2 text-[11px] text-gray-400">
              <span>
                Size: {kymograph.spatialLength} × {kymograph.timeCount}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <p className="mb-2 text-gray-400">Space-Time Visualization</p>
            <p className="text-sm text-gray-500">Select an Analysis ROI</p>
            <p className="mt-4 text-xs text-gray-600">
              Kymograph will update from raw ROI pixels
              <br />
              to demonstrate the data pipeline.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default KymographsPanel;
