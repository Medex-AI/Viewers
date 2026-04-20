const toHexByte = (value: number) => {
  const hex = value.toString(16);
  return hex.length === 1 ? `0${hex}` : hex;
};

export const hexToRgb = (hex: string): [number, number, number] => {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) {
    return [255, 255, 255];
  }

  const intValue = parseInt(normalized, 16);
  return [(intValue >> 16) & 255, (intValue >> 8) & 255, intValue & 255];
};

export const hexToRgba255 = (hexColor: string): [number, number, number, number] => {
  const [r, g, b] = hexToRgb(hexColor);
  return [r, g, b, 255];
};

export const lightenHexColor = (hexColor: string, ratio = 0.35) => {
  const [r, g, b] = hexToRgb(hexColor);

  const next = [r, g, b]
    .map(channel => Math.min(255, Math.round(channel * (1 - ratio) + 255 * ratio)))
    .map(toHexByte)
    .join('');

  return `#${next}`;
};

export const getContrastColor = (hexColor: string) => {
  const [r, g, b] = hexToRgb(hexColor);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.68 ? '#0F172A' : '#F8FAFC';
};
