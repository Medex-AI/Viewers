import React from 'react';
import { Icons } from '../Icons/Icons';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '../DropdownMenu';
import { Button } from '../Button/Button';
import { Numeric } from '../Numeric/Numeric';

/** Parse any CSS color string (hex or rgb()) into an [r, g, b] tuple. */
const parseColor = (colorStr: string): [number, number, number] => {
  if (colorStr.startsWith('#')) {
    const s = colorStr.replace('#', '');
    const safe = s.length === 6 ? s : 'ffffff';
    return [
      parseInt(safe.slice(0, 2), 16),
      parseInt(safe.slice(2, 4), 16),
      parseInt(safe.slice(4, 6), 16),
    ];
  }
  const m = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m) {
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  }
  return [255, 255, 255];
};

const toRgba = (rgb: [number, number, number], alpha: number) =>
  `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;

const EyeVisibleIcon = ({ className = '' }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
    />
  </svg>
);

const EyeHiddenIcon = ({ className = '' }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
    />
  </svg>
);

const OPACITY_STEP = 0.05;
const clamp = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));

export interface SegmentCardProps {
  /** Segment or label name from the backend. */
  label: string;
  /**
   * CSS color string — hex (`#22D3EE`) or `rgb(r,g,b)` accepted.
   * Used to tint the card border and background.
   */
  colorHex: string;
  visible: boolean;
  /** Whether this card is the currently active/selected segment. */
  active: boolean;
  /** Fill opacity (0–1). */
  opacity: number;
  /** Sub-header text shown between the frame-nav arrows. */
  frameInfo?: string;
  /** Called when the < / > frame navigation buttons are clicked. */
  onStepFrame?: (delta: number) => void;
  /** Optional explicit navigation groups; when set, replaces frameInfo/onStepFrame header nav. */
  navigationGroups?: Array<{
    key: string;
    label: string;
    onStep?: (delta: number) => void;
    prevTitle?: string;
    nextTitle?: string;
  }>;
  onToggleVisibility?: () => void;
  /** Keeps the eye button visible but non-interactive. */
  visibilityDisabled?: boolean;
  /** Called when the opacity slider or +/- buttons change the value. */
  onOpacityChange?: (value: number) => void;
  /**
   * Content rendered inside the icon-more (⋯) dropdown.
   * Typically one or more `DropdownMenuItem` elements.
   * When undefined or null the icon-more button is hidden.
   */
  moreMenuContent?: React.ReactNode;
  onSelect?: () => void;
  /** Right-click context-menu handler (kept for backwards compat). */
  onContextMenu?: (e: React.MouseEvent) => void;
  className?: string;
}

/**
 * Generic segment / label card used in both the OVI Labs panel and the
 * segmentation-mode panel.  Accepts a colour, label, visibility, opacity,
 * frame navigation and an optional icon-more dropdown whose items are
 * provided by the caller, keeping the visual style consistent across modes.
 */
export const SegmentCard: React.FC<SegmentCardProps> = ({
  label,
  colorHex,
  visible,
  active,
  opacity,
  frameInfo,
  onStepFrame,
  navigationGroups,
  onToggleVisibility,
  visibilityDisabled = false,
  onOpacityChange,
  moreMenuContent,
  onSelect,
  onContextMenu,
  className = '',
}) => {
  const rgb = parseColor(colorHex);
  const cssColor = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  const resolvedNavigationGroups = navigationGroups?.length
    ? navigationGroups
    : frameInfo
      ? [
          {
            key: 'frame',
            label: frameInfo,
            onStep: onStepFrame,
            prevTitle: 'Previous frame',
            nextTitle: 'Next frame',
          },
        ]
      : [];

  // Per-card scoped CSS variables for the Numeric slider track
  const cardStyle = {
    '--seg-color': cssColor,
    '--seg-rail': toRgba(rgb, 0.24),
    '--seg-fill-bg': toRgba(rgb, 0.08),
    '--seg-thumb-border': 'rgba(15, 23, 42, 0.9)',
  } as React.CSSProperties;

  const sliderCss = `
    .seg-card-scoped .seg-slider > span:first-of-type { background: var(--seg-rail); height: 0.25rem; }
    .seg-card-scoped .seg-slider > span:first-of-type > span { background: var(--seg-color); }
    .seg-card-scoped .seg-slider > span:last-of-type { background: transparent !important; border-color: transparent !important; box-shadow: none; color: transparent; }
    .seg-card-scoped .seg-slider > span:last-of-type > [role='slider'] { background: var(--seg-color) !important; border-color: var(--seg-thumb-border) !important; border-width: 2px !important; box-shadow: none !important; color: var(--seg-color) !important; width: 1rem !important; height: 1rem !important; }
    .seg-card-scoped .seg-number-input { border-color: var(--seg-color) !important; color: var(--seg-color) !important; background: var(--seg-fill-bg) !important; }
    .seg-card-scoped .seg-number-input:hover { background: var(--seg-fill-bg) !important; }
  `;

  return (
    <>
      <style>{sliderCss}</style>
      <div
        data-cy="data-row"
        className={`flex overflow-hidden rounded-md border ${!visible ? 'opacity-70' : ''} ${className}`}
        style={{
          borderColor: cssColor,
          backgroundColor: toRgba(rgb, 0.12),
          boxShadow: active ? `0 0 0 2px ${cssColor}` : undefined,
          borderWidth: active ? 2 : 1,
        }}
        onClick={onSelect}
        onContextMenu={onContextMenu}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* ── Header row ─────────────────────────────────────────── */}
          <div
            className="flex items-start justify-between gap-2 px-2.5 py-1"
            style={{ backgroundColor: toRgba(rgb, 0.3) }}
          >
            {/* Label + frame nav */}
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-gray-100">{label}</div>
              {resolvedNavigationGroups.length > 0 && (
                <div className="mt-0.5 flex flex-col gap-y-1 text-[10px] text-gray-300">
                  {resolvedNavigationGroups.map(group => (
                    <div
                      key={group.key}
                      className="flex min-w-0 items-center gap-1"
                    >
                      {group.onStep && (
                        <button
                          type="button"
                          className="inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] leading-none transition-colors"
                          title={group.prevTitle || 'Previous'}
                          style={{
                            borderColor: cssColor,
                            color: cssColor,
                            backgroundColor: toRgba(rgb, 0.08),
                          }}
                          onClick={e => {
                            e.stopPropagation();
                            group.onStep?.(-1);
                          }}
                        >
                          &lt;
                        </button>
                      )}
                      <span className="truncate">{group.label}</span>
                      {group.onStep && (
                        <button
                          type="button"
                          className="inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] leading-none transition-colors"
                          title={group.nextTitle || 'Next'}
                          style={{
                            borderColor: cssColor,
                            color: cssColor,
                            backgroundColor: toRgba(rgb, 0.08),
                          }}
                          onClick={e => {
                            e.stopPropagation();
                            group.onStep?.(1);
                          }}
                        >
                          &gt;
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Eye visibility toggle */}
            {(onToggleVisibility || visibilityDisabled) && (
              <button
                type="button"
                title={visible ? 'Hide' : 'Show'}
                disabled={visibilityDisabled}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors ${
                  visibilityDisabled ? 'cursor-not-allowed opacity-40' : ''
                }`}
                style={{
                  color: cssColor,
                  backgroundColor: visible ? toRgba(rgb, 0.14) : 'transparent',
                }}
                onClick={e => {
                  e.stopPropagation();
                  if (!visibilityDisabled) {
                    onToggleVisibility?.();
                  }
                }}
              >
                {visible ? (
                  <EyeVisibleIcon className="h-4 w-4" />
                ) : (
                  <EyeHiddenIcon className="h-4 w-4" />
                )}
              </button>
            )}

            {/* Icon-more dropdown */}
            {moreMenuContent && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5 shrink-0 p-0 hover:opacity-90"
                    title="Label Options"
                    aria-label="Actions"
                    style={{
                      color: cssColor,
                      backgroundColor: toRgba(rgb, 0.08),
                    }}
                    onClick={e => e.stopPropagation()}
                  >
                    <Icons.More className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={e => e.preventDefault()}
                >
                  {moreMenuContent}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {/* ── Opacity control ────────────────────────────────────── */}
          {onOpacityChange && (
            <div
              className="seg-card-scoped min-w-0 flex-1 px-2.5 pb-2"
              style={cardStyle}
            >
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-gray-300">
                  Opacity
                </span>
                <button
                  type="button"
                  className="h-7 w-7 rounded border text-base leading-none transition-colors"
                  style={{
                    borderColor: cssColor,
                    color: cssColor,
                    backgroundColor: toRgba(rgb, 0.08),
                  }}
                  onClick={e => {
                    e.stopPropagation();
                    onOpacityChange(clamp(opacity - OPACITY_STEP));
                  }}
                >
                  -
                </button>
                <Numeric.Container
                  mode="singleRange"
                  value={opacity}
                  onChange={v =>
                    onOpacityChange(
                      clamp(typeof v === 'number' ? v : (v as number[])[0])
                    )
                  }
                  min={0}
                  max={1}
                  step={OPACITY_STEP}
                  className="flex min-w-0 flex-1 flex-row items-center space-x-2"
                >
                  <Numeric.SingleRange
                    showNumberInput
                    sliderClassName="seg-slider w-full"
                    numberInputClassName="seg-number-input w-[50px] shrink-0"
                    beforeNumberInput={
                      <button
                        type="button"
                        className="h-7 w-7 rounded border text-base leading-none transition-colors"
                        style={{
                          borderColor: cssColor,
                          color: cssColor,
                          backgroundColor: toRgba(rgb, 0.08),
                        }}
                        onClick={e => {
                          e.stopPropagation();
                          onOpacityChange(clamp(opacity + OPACITY_STEP));
                        }}
                      >
                        +
                      </button>
                    }
                  />
                </Numeric.Container>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default SegmentCard;
