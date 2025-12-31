export type WindowType = 'hann' | 'rectangular';

export const nextPowerOfTwo = (value: number) => {
  let size = 1;
  while (size < value) {
    size <<= 1;
  }
  return size;
};

const buildWindowValue = (index: number, length: number, window: WindowType) => {
  if (window === 'hann' && length > 1) {
    return 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)));
  }
  return 1;
};

export const fftRadix2 = (real: Float32Array, imag?: Float32Array) => {
  const n = real.length;
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error('FFT input length must be a power of two.');
  }

  const imagValues = imag ?? new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    if (j > i) {
      [real[i], real[j]] = [real[j], real[i]];
      [imagValues[i], imagValues[j]] = [imagValues[j], imagValues[i]];
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const phaseShiftStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let offset = 0; offset < half; offset += 1) {
        const angle = offset * phaseShiftStep;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const evenIndex = start + offset;
        const oddIndex = evenIndex + half;
        const tr = real[oddIndex] * cos - imagValues[oddIndex] * sin;
        const ti = real[oddIndex] * sin + imagValues[oddIndex] * cos;
        real[oddIndex] = real[evenIndex] - tr;
        imagValues[oddIndex] = imagValues[evenIndex] - ti;
        real[evenIndex] += tr;
        imagValues[evenIndex] += ti;
      }
    }
  }

  return { real, imag: imagValues };
};

export const computeFftMagnitudes = (signal: Float32Array, window: WindowType) => {
  const size = nextPowerOfTwo(signal.length);
  const real = new Float32Array(size);
  const imag = new Float32Array(size);

  for (let i = 0; i < signal.length; i += 1) {
    real[i] = signal[i] * buildWindowValue(i, signal.length, window);
  }

  fftRadix2(real, imag);

  const half = size >> 1;
  const magnitudes = new Float32Array(half);
  for (let i = 0; i < half; i += 1) {
    magnitudes[i] = Math.hypot(real[i], imag[i]);
  }

  return { magnitudes, size };
};

export const compute2dFftMagnitudes = (
  data: Float32Array,
  width: number,
  height: number
) => {
  const paddedWidth = nextPowerOfTwo(width);
  const paddedHeight = nextPowerOfTwo(height);
  const real = new Float32Array(paddedWidth * paddedHeight);
  const imag = new Float32Array(paddedWidth * paddedHeight);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      real[y * paddedWidth + x] = data[y * width + x];
    }
  }

  for (let y = 0; y < paddedHeight; y += 1) {
    const rowReal = new Float32Array(paddedWidth);
    const rowImag = new Float32Array(paddedWidth);
    const baseIndex = y * paddedWidth;
    for (let x = 0; x < paddedWidth; x += 1) {
      rowReal[x] = real[baseIndex + x];
      rowImag[x] = imag[baseIndex + x];
    }
    fftRadix2(rowReal, rowImag);
    for (let x = 0; x < paddedWidth; x += 1) {
      real[baseIndex + x] = rowReal[x];
      imag[baseIndex + x] = rowImag[x];
    }
  }

  for (let x = 0; x < paddedWidth; x += 1) {
    const colReal = new Float32Array(paddedHeight);
    const colImag = new Float32Array(paddedHeight);
    for (let y = 0; y < paddedHeight; y += 1) {
      const index = y * paddedWidth + x;
      colReal[y] = real[index];
      colImag[y] = imag[index];
    }
    fftRadix2(colReal, colImag);
    for (let y = 0; y < paddedHeight; y += 1) {
      const index = y * paddedWidth + x;
      real[index] = colReal[y];
      imag[index] = colImag[y];
    }
  }

  const magnitudes = new Float32Array(paddedWidth * paddedHeight);
  for (let i = 0; i < magnitudes.length; i += 1) {
    magnitudes[i] = Math.hypot(real[i], imag[i]);
  }

  return { magnitudes, width: paddedWidth, height: paddedHeight };
};

export const fftShift2d = (data: Float32Array, width: number, height: number) => {
  const shifted = new Float32Array(data.length);
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const newX = (x + halfWidth) % width;
      const newY = (y + halfHeight) % height;
      shifted[newY * width + newX] = data[y * width + x];
    }
  }

  return shifted;
};
