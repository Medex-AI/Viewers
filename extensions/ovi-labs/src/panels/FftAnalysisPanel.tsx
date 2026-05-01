import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  COLORMAP_OPTIONS,
  COLORMAP_STOPS,
  Dropdown,
  colormapGradient,
  sampleColormap,
} from '../components/ColormapDropdown';
import {
  getRoiAnalysisData,
  subscribeRoiAnalysisData,
} from '../utils/roiAnalysisDataStore';
import { extractFrameTimingFromImageIds } from '../utils/dicomMetadataExtractor';
import {
  compute2dFftMagnitudes,
  computeFftMagnitudes,
  fftShift2d,
  nextPowerOfTwo,
  WindowType,
} from '../utils/fftUtils';
import {
  getFrameRate,
  setFrameRate,
  subscribeFrameRate,
} from '../utils/frameRateStore';
import {
  setKymographSettings,
  subscribeKymographSettings,
} from '../utils/kymographSettingsStore';

interface FftAnalysisPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

const FFT_SOURCE_OPTIONS = [
  { value: 'major', label: 'Major axis profile' },
  { value: 'minor', label: 'Minor axis profile' },
  { value: 'roi2d', label: '2D ROI FFT' },
];

const WINDOW_OPTIONS: Array<{ value: WindowType; label: string }> = [
  { value: 'hann', label: 'Hann' },
  { value: 'rectangular', label: 'Rectangular' },
];

const SCALE_OPTIONS = [
  { value: 'log', label: 'Log scale' },
  { value: 'linear', label: 'Linear scale' },
];

const FftAnalysisPanel: React.FC<FftAnalysisPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  const [analysisData, setAnalysisData] = useState(getRoiAnalysisData());
  const [fftSource, setFftSource] = useState('major');
  const [windowType, setWindowType] = useState<WindowType>('hann');
  const [scaleType, setScaleType] = useState('log');
  const [colormap, setColormap] = useState('viridis');
  const [frameRateInput, setFrameRateInput] = useState(getFrameRate().toString());
  const [showWindowHelp, setShowWindowHelp] = useState(false);
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fftCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeRoiAnalysisData(nextData => {
      setAnalysisData(nextData);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeFrameRate(value => {
      setFrameRateInput(value.toString());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeKymographSettings(settings => {
      if (fftSource !== 'roi2d' && settings.spatialAxis !== fftSource) {
        setFftSource(settings.spatialAxis);
      }
    });
    return unsubscribe;
  }, [fftSource]);

  useEffect(() => {
    if (fftSource === 'major' || fftSource === 'minor') {
      setKymographSettings({ spatialAxis: fftSource });
    }
  }, [fftSource]);

  const metadataFrameRate = useMemo(() => {
    const directFrameRate = analysisData?.frameRate;
    if (Number.isFinite(directFrameRate) && directFrameRate && directFrameRate > 0) {
      return directFrameRate;
    }
    const imageIds = analysisData?.imageIds || [];
    if (!imageIds.length) {
      return null;
    }
    return extractFrameTimingFromImageIds(imageIds).frameRate;
  }, [analysisData?.frameRate, analysisData?.imageIds]);

  const resolvedFrameRate = useMemo(() => {
    const parsed = Number(frameRateInput);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return metadataFrameRate;
  }, [frameRateInput, metadataFrameRate]);

  const spectrumData = useMemo(() => {
    if (!analysisData?.frames?.length) {
      return null;
    }

    const { frames, width, height } = analysisData;
    const timeCount = frames.length;

    if (timeCount < 2) {
      return null;
    }

    if (fftSource === 'roi2d') {
      const meanFrame = new Float32Array(width * height);
      frames.forEach(frame => {
        for (let i = 0; i < meanFrame.length; i += 1) {
          meanFrame[i] += frame[i] || 0;
        }
      });
      for (let i = 0; i < meanFrame.length; i += 1) {
        meanFrame[i] /= timeCount;
      }

      const { magnitudes, width: fftWidth, height: fftHeight } = compute2dFftMagnitudes(
        meanFrame,
        width,
        height
      );
      const shifted = fftShift2d(magnitudes, fftWidth, fftHeight);

      return {
        type: '2d' as const,
        magnitudes: shifted,
        width: fftWidth,
        height: fftHeight,
      };
    }

    const axisForData = (() => {
      if (fftSource === 'major') {
        return width >= height ? 'x' : 'y';
      }
      if (fftSource === 'minor') {
        return width >= height ? 'y' : 'x';
      }
      return 'x';
    })();

    const spatialLength = axisForData === 'y' ? height : width;
    const matrix = new Float32Array(timeCount * spatialLength);

    frames.forEach((frame, frameIndex) => {
      if (axisForData === 'y') {
        for (let row = 0; row < height; row += 1) {
          let sum = 0;
          const rowOffset = row * width;
          for (let col = 0; col < width; col += 1) {
            sum += frame[rowOffset + col];
          }
          matrix[frameIndex * spatialLength + row] = sum / width;
        }
      } else {
        for (let col = 0; col < width; col += 1) {
          let sum = 0;
          for (let row = 0; row < height; row += 1) {
            sum += frame[row * width + col];
          }
          matrix[frameIndex * spatialLength + col] = sum / height;
        }
      }
    });

    const fftSize = nextPowerOfTwo(timeCount);
    const halfSize = fftSize >> 1;
    const spectrum = new Float32Array(halfSize);
    const spectrumMatrix = new Float32Array(halfSize * spatialLength);
    const tempSeries = new Float32Array(timeCount);

    for (let spatialIndex = 0; spatialIndex < spatialLength; spatialIndex += 1) {
      for (let timeIndex = 0; timeIndex < timeCount; timeIndex += 1) {
        tempSeries[timeIndex] = matrix[timeIndex * spatialLength + spatialIndex];
      }
      const { magnitudes } = computeFftMagnitudes(tempSeries, windowType);
      for (let bin = 0; bin < halfSize; bin += 1) {
        spectrum[bin] += magnitudes[bin];
        spectrumMatrix[bin * spatialLength + spatialIndex] = magnitudes[bin];
      }
    }

    for (let bin = 0; bin < halfSize; bin += 1) {
      spectrum[bin] /= spatialLength;
    }

    const sampleRate = resolvedFrameRate ?? 1;
    const frequencies = new Float32Array(halfSize);
    for (let bin = 0; bin < halfSize; bin += 1) {
      frequencies[bin] = (bin * sampleRate) / fftSize;
    }

    let peakIndex = 0;
    let peakMagnitude = -Infinity;
    for (let bin = 1; bin < spectrum.length; bin += 1) {
      if (spectrum[bin] > peakMagnitude) {
        peakMagnitude = spectrum[bin];
        peakIndex = bin;
      }
    }

    return {
      type: '1d' as const,
      magnitudes: spectrum,
      matrix: spectrumMatrix,
      frequencies,
      fftSize,
      timeCount,
      spatialLength,
      axis: axisForData,
      peak: {
        index: peakIndex,
        frequency: frequencies[peakIndex] ?? 0,
        magnitude: spectrum[peakIndex] ?? 0,
      },
    };
  }, [analysisData, fftSource, windowType, resolvedFrameRate]);

  useEffect(() => {
    if (!spectrumData || spectrumData.type !== '1d') {
      return;
    }

    const canvas = spectrumCanvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 300;
    const height = canvas.clientHeight || 200;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);

    const leftMargin = 50;
    const rightMargin = 12;
    const topMargin = 10;
    const bottomMargin = 34;
    const plotWidth = width - leftMargin - rightMargin;
    const plotHeight = height - topMargin - bottomMargin;

    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, width, height);

    const values = spectrumData.matrix;
    const spatialLength = spectrumData.spatialLength;
    const freqBins = spectrumData.frequencies.length;
    const scaledValues = new Float32Array(values.length);
    let minValue = Infinity;
    let maxValue = -Infinity;

    for (let i = 0; i < values.length; i += 1) {
      const magnitudeValue =
        scaleType === 'log' ? Math.log10(values[i] + 1) : values[i];
      scaledValues[i] = magnitudeValue;
      minValue = Math.min(minValue, magnitudeValue);
      maxValue = Math.max(maxValue, magnitudeValue);
    }

    const range = maxValue - minValue || 1;
    const imageData = ctx.createImageData(freqBins, spatialLength);
    for (let y = 0; y < spatialLength; y += 1) {
      for (let x = 0; x < freqBins; x += 1) {
        const srcIndex = x * spatialLength + y;
        const normalized = (scaledValues[srcIndex] - minValue) / range;
        const [r, g, b] = sampleColormap(colormap, normalized);
        const pixelIndex = (y * freqBins + x) * 4;
        imageData.data[pixelIndex] = r;
        imageData.data[pixelIndex + 1] = g;
        imageData.data[pixelIndex + 2] = b;
        imageData.data[pixelIndex + 3] = 255;
      }
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = freqBins;
    tempCanvas.height = spatialLength;
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      tempCtx.putImageData(imageData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tempCanvas, leftMargin, topMargin, plotWidth, plotHeight);
    }

    const maxFrequency = spectrumData.frequencies[freqBins - 1] || 1;
    const targetTicks = 5;
    const rawStep = maxFrequency / targetTicks;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const baseSteps = [1, 2, 5, 10];
    let tickEvery = baseSteps[baseSteps.length - 1] * magnitude;
    for (const base of baseSteps) {
      const candidate = base * magnitude;
      if (candidate >= rawStep) {
        tickEvery = candidate;
        break;
      }
    }

    const tickEveryPxX = (tickEvery / maxFrequency) * plotWidth;
    const tickLength = 6;
    const labelOffset = 3;
    const fontSize = 10;
    ctx.strokeStyle = '#F47620';
    ctx.fillStyle = '#F47620';
    ctx.lineWidth = 1;
    ctx.font = `${fontSize}px Arial, Helvetica, sans-serif`;

    if (tickEveryPxX > 8) {
      let tickIndex = 0;
      const bottomY = topMargin + plotHeight;
      for (let x = leftMargin; x <= leftMargin + plotWidth + 0.5; x += tickEveryPxX) {
        const labelValue = tickIndex * tickEvery;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.beginPath();
        ctx.moveTo(x, bottomY);
        ctx.lineTo(x, bottomY + tickLength);
        ctx.stroke();
        if (tickIndex !== 0) {
          ctx.fillText(labelValue.toFixed(2), x, bottomY + tickLength + labelOffset);
        }
        tickIndex += 1;
      }
    }

    const spacing = analysisData?.spacing;
    const hasSpacing =
      spacing &&
      typeof spacing.row === 'number' &&
      typeof spacing.column === 'number' &&
      spacing.row > 0 &&
      spacing.column > 0;
    const spatialSpacing = spectrumData.axis === 'y' ? spacing?.row : spacing?.column;
    const spatialUnitLength =
      hasSpacing && spatialSpacing ? spatialLength * spatialSpacing : spatialLength;
    const spatialUnitLabel = hasSpacing ? 'mm' : 'px';
    const spatialStep = spatialUnitLength > 0 ? spatialUnitLength / targetTicks : 0;
    const spatialPixelStep =
      spatialUnitLength > 0 ? (spatialStep / spatialUnitLength) * plotWidth : 0;

    if (spatialPixelStep > 8) {
      let tickIndex = 0;
      for (let y = topMargin + plotHeight; y >= topMargin - 0.5; y -= spatialPixelStep) {
        const labelValue = tickIndex * spatialStep;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.beginPath();
        ctx.moveTo(leftMargin, y);
        ctx.lineTo(leftMargin - tickLength, y);
        ctx.stroke();
        if (tickIndex !== 0) {
          ctx.fillText(labelValue.toFixed(1), leftMargin - tickLength - labelOffset, y);
        }
        tickIndex += 1;
      }
    }

    ctx.save();
    ctx.translate(width / 2, height - 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const unitLabel = resolvedFrameRate ? 'Hz' : 'cycles/frame';
    ctx.fillText(`Frequency (${unitLabel})`, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.translate(14, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Position (${spatialUnitLabel})`, 0, 0);
    ctx.restore();
  }, [spectrumData, scaleType, resolvedFrameRate, colormap, analysisData?.spacing]);

  useEffect(() => {
    if (!spectrumData || spectrumData.type !== '2d') {
      return;
    }

    const canvas = fftCanvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 300;
    const height = canvas.clientHeight || 200;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);

    const leftMargin = 10;
    const topMargin = 10;
    const rightMargin = 10;
    const bottomMargin = 10;
    const plotWidth = width - leftMargin - rightMargin;
    const plotHeight = height - topMargin - bottomMargin;

    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, width, height);

    const values = spectrumData.magnitudes;
    let min = Infinity;
    let max = -Infinity;
    const scaledValues = new Float32Array(values.length);
    for (let i = 0; i < values.length; i += 1) {
      const value = scaleType === 'log' ? Math.log10(values[i] + 1) : values[i];
      scaledValues[i] = value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const range = max - min || 1;

    const imageData = ctx.createImageData(spectrumData.width, spectrumData.height);
    for (let y = 0; y < spectrumData.height; y += 1) {
      for (let x = 0; x < spectrumData.width; x += 1) {
        const index = y * spectrumData.width + x;
        const normalized = (scaledValues[index] - min) / range;
        const [r, g, b] = sampleColormap(colormap, normalized);
        const pixelIndex = index * 4;
        imageData.data[pixelIndex] = r;
        imageData.data[pixelIndex + 1] = g;
        imageData.data[pixelIndex + 2] = b;
        imageData.data[pixelIndex + 3] = 255;
      }
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = spectrumData.width;
    tempCanvas.height = spectrumData.height;
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      tempCtx.putImageData(imageData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tempCanvas, leftMargin, topMargin, plotWidth, plotHeight);
    }
  }, [spectrumData, colormap, scaleType]);

  const unitLabel = resolvedFrameRate ? 'Hz' : 'cycles/frame';
  const sourceOption = FFT_SOURCE_OPTIONS.find(option => option.value === fftSource);
  const windowOption = WINDOW_OPTIONS.find(option => option.value === windowType);
  const scaleOption = SCALE_OPTIONS.find(option => option.value === scaleType);
  const colormapOption = COLORMAP_OPTIONS.find(option => option.value === colormap);

  return (
    <div className="flex h-full w-full flex-col bg-black p-4 text-white">
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
          <span className="text-gray-400">FFT source</span>
          <Dropdown
            ariaLabel="FFT source"
            value={sourceOption?.value || FFT_SOURCE_OPTIONS[0].value}
            options={FFT_SOURCE_OPTIONS}
            onChange={setFftSource}
          />
        </div>
        {fftSource !== 'roi2d' ? (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-gray-400">
              Window
              <button
                type="button"
                className="rounded border border-gray-700 px-1 text-[10px] text-gray-300"
                onClick={() => setShowWindowHelp(true)}
              >
                ?
              </button>
            </span>
            <Dropdown
              ariaLabel="Window"
              value={windowOption?.value || WINDOW_OPTIONS[0].value}
              options={WINDOW_OPTIONS}
              onChange={value => setWindowType(value as WindowType)}
            />
          </div>
        ) : null}
        <div className="flex items-center justify-between">
          <span className="text-gray-400">
            {fftSource === 'roi2d' ? 'Magnitude scale' : 'Scale'}
          </span>
          <Dropdown
            ariaLabel="Scale"
            value={scaleOption?.value || SCALE_OPTIONS[0].value}
            options={SCALE_OPTIONS}
            onChange={setScaleType}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Colormap</span>
          <Dropdown
            ariaLabel="Colormap"
            value={colormapOption?.value || COLORMAP_OPTIONS[0].value}
            options={COLORMAP_OPTIONS}
            onChange={setColormap}
            renderPreview={value => (
              <span
                className="h-2 w-10 rounded"
                style={{ backgroundImage: colormapGradient(value) }}
              />
            )}
          />
        </div>
        {fftSource === 'roi2d' ? (
          <div className="flex items-center justify-between">
            <span className="text-gray-400">FFT window</span>
            <span className="text-[10px] text-gray-500">Not applied for 2D FFT</span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-1 items-center justify-center rounded bg-gray-900">
        {spectrumData ? (
          spectrumData.type === '1d' ? (
            <div className="flex h-full w-full flex-col">
              <div className="flex-1 p-3">
                <div className="h-full w-full rounded bg-black">
                  <canvas ref={spectrumCanvasRef} className="h-full w-full" />
                </div>
              </div>
              <div className="border-t border-gray-800 px-3 py-2 text-[11px] text-gray-400">
                <span>
                  Peak: {spectrumData.peak.frequency.toFixed(2)} {unitLabel}
                </span>
                <span className="ml-4">
                  Resolution: {(resolvedFrameRate ? resolvedFrameRate / spectrumData.fftSize : 1 / spectrumData.fftSize).toFixed(3)}{' '}
                  {unitLabel}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col">
              <div className="flex-1 p-3">
                <div className="flex h-full w-full items-center justify-center">
                  <div
                    className="w-full max-h-full max-w-full rounded bg-black"
                    style={{
                      aspectRatio:
                        analysisData?.width && analysisData?.height
                          ? `${analysisData.width} / ${analysisData.height}`
                          : `${spectrumData.width} / ${spectrumData.height}`,
                    }}
                  >
                    <canvas
                      ref={fftCanvasRef}
                      className="h-full w-full"
                      style={{ imageRendering: 'pixelated' }}
                    />
                  </div>
                </div>
              </div>
              <div className="border-t border-gray-800 px-3 py-2 text-[11px] text-gray-400">
                <span>
                  ROI size:{' '}
                  {analysisData?.width ?? spectrumData.width} ×{' '}
                  {analysisData?.height ?? spectrumData.height}
                </span>
                <span className="ml-4">FFT: {spectrumData.width} × {spectrumData.height}</span>
                <span className="ml-4">
                  {scaleType === 'log' ? 'Log' : 'Linear'} magnitude
                </span>
              </div>
            </div>
          )
        ) : (
          <div className="text-center">
            <p className="mb-2 text-gray-400">Frequency Spectrum</p>
            <p className="text-sm text-gray-500">Select an Analysis ROI</p>
            <p className="mt-4 text-xs text-gray-600">
              FFT updates live from the ROI selection
              <br />
              using the scanning frame rate when available.
            </p>
          </div>
        )}
      </div>
      {showWindowHelp ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded border border-gray-700 bg-gray-900 p-4 text-xs text-gray-200">
            <div className="mb-2 text-sm font-semibold text-white">Windowing</div>
            <p className="text-gray-300">
              Windowing tapers the time-series before the FFT to reduce spectral leakage.
              Hann is a good default for smooth signals; rectangular preserves raw
              amplitudes but can introduce more leakage.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded border border-gray-700 px-3 py-1 text-[11px] text-gray-200 hover:bg-gray-800"
                onClick={() => setShowWindowHelp(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default FftAnalysisPanel;
