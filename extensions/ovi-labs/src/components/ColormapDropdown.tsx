import React, { useEffect, useRef, useState } from 'react';

export const COLORMAP_OPTIONS = [
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'plasma', label: 'Plasma' },
  { value: 'inferno', label: 'Inferno' },
  { value: 'magma', label: 'Magma' },
  { value: 'cividis', label: 'Cividis' },
];

export const COLORMAP_STOPS: Record<string, Array<[number, number, number]>> = {
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

export const sampleColormap = (name: string, value: number): number[] => {
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

export const colormapGradient = (name: string): string => {
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

export type DropdownOption = { value: string; label: string };

export interface DropdownProps {
  ariaLabel: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  renderPreview?: (value: string) => React.ReactNode;
  className?: string;
}

export const Dropdown: React.FC<DropdownProps> = ({
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
