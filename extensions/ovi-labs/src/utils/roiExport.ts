export type RoiExportSpacing = {
  row: number | null;
  column: number | null;
};

export const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const requestSaveHandle = async (
  filename: string,
  mimeType: string
): Promise<FileSystemFileHandle | null> => {
  const picker = (window as any)?.showSaveFilePicker;
  if (!picker) {
    return null;
  }

  return await picker({
    suggestedName: filename,
    types: [
      {
        description: 'ROI export',
        accept: { [mimeType]: [`.${filename.split('.').pop() || ''}`] },
      },
    ],
  });
};

export const writeBufferToHandle = async (
  handle: FileSystemFileHandle,
  buffer: ArrayBuffer,
  mimeType: string
): Promise<void> => {
  const writable = await handle.createWritable();
  await writable.write(new Blob([buffer], { type: mimeType }));
  await writable.close();
};

export type RoiExportFrame = Int16Array | Uint16Array | Uint8Array | Float32Array;

const getNiftiDataInfo = (frames: RoiExportFrame[]) => {
  const sample = frames[0];
  if (sample instanceof Int16Array) {
    return { ctor: Int16Array, datatype: 4, bitpix: 16 };
  }
  if (sample instanceof Uint16Array) {
    return { ctor: Uint16Array, datatype: 512, bitpix: 16 };
  }
  if (sample instanceof Uint8Array) {
    return { ctor: Uint8Array, datatype: 2, bitpix: 8 };
  }
  return { ctor: Float32Array, datatype: 16, bitpix: 32 };
};

const setString = (view: DataView, offset: number, value: string): void => {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
};

export const buildNiftiBuffer = ({
  frames,
  width,
  height,
  spacing,
  frameTimeMs,
}: {
  frames: RoiExportFrame[];
  width: number;
  height: number;
  spacing: RoiExportSpacing;
  frameTimeMs: number | null;
}): ArrayBuffer => {
  const frameCount = frames.length;
  const voxelCount = width * height * frameCount;
  const { ctor, datatype, bitpix } = getNiftiDataInfo(frames);
  const data = new ctor(voxelCount);

  frames.forEach((frame, index) => {
    data.set(frame as InstanceType<typeof ctor>, index * width * height);
  });

  const headerSize = 348;
  const voxOffset = 352;
  const buffer = new ArrayBuffer(voxOffset + data.byteLength);
  const view = new DataView(buffer);

  view.setInt32(0, headerSize, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, width, true);
  view.setInt16(44, height, true);
  view.setInt16(46, frameCount, true);
  view.setInt16(48, 1, true);
  view.setInt16(50, 1, true);
  view.setInt16(52, 1, true);
  view.setInt16(54, 1, true);

  view.setInt16(70, datatype, true);
  view.setInt16(72, bitpix, true);

  view.setFloat32(76, 0, true);
  view.setFloat32(80, spacing.column ?? 1, true);
  view.setFloat32(84, spacing.row ?? 1, true);
  view.setFloat32(88, frameTimeMs ? frameTimeMs / 1000 : 1, true);
  view.setFloat32(92, 1, true);
  view.setFloat32(96, 1, true);
  view.setFloat32(100, 1, true);
  view.setFloat32(104, 1, true);

  view.setFloat32(108, voxOffset, true);
  view.setInt16(123, 10, true);

  setString(view, 344, 'n+1\0');

  const dataView = new ctor(buffer, voxOffset, data.length);
  dataView.set(data);

  return buffer;
};

const getTiffInfo = (frames: RoiExportFrame[]) => {
  const sample = frames[0];
  if (sample instanceof Int16Array) {
    return { bytes: 2, bits: 16, sampleFormat: 2, ctor: Int16Array };
  }
  if (sample instanceof Uint16Array) {
    return { bytes: 2, bits: 16, sampleFormat: 1, ctor: Uint16Array };
  }
  if (sample instanceof Uint8Array) {
    return { bytes: 1, bits: 8, sampleFormat: 1, ctor: Uint8Array };
  }
  return { bytes: 4, bits: 32, sampleFormat: 3, ctor: Float32Array };
};

export const buildTiffBuffer = ({
  frames,
  width,
  height,
}: {
  frames: RoiExportFrame[];
  width: number;
  height: number;
}): ArrayBuffer => {
  const frameCount = frames.length;
  const { bytes, bits, sampleFormat, ctor } = getTiffInfo(frames);
  const entries = 10;
  const ifdSize = 2 + entries * 12 + 4;
  const imageDataOffset = 8 + frameCount * ifdSize;
  const frameSizeBytes = width * height * bytes;
  const totalSize = imageDataOffset + frameCount * frameSizeBytes;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  const dataView = new ctor(buffer, imageDataOffset);
  frames.forEach((frame, index) => {
    const offset = index * width * height;
    dataView.set(frame as InstanceType<typeof ctor>, offset);
  });

  const writeEntry = (
    ifdOffset: number,
    entryIndex: number,
    tag: number,
    type: number,
    count: number,
    value: number
  ) => {
    const entryOffset = ifdOffset + 2 + entryIndex * 12;
    view.setUint16(entryOffset, tag, true);
    view.setUint16(entryOffset + 2, type, true);
    view.setUint32(entryOffset + 4, count, true);
    view.setUint32(entryOffset + 8, value, true);
  };

  for (let i = 0; i < frameCount; i += 1) {
    const ifdOffset = 8 + i * ifdSize;
    const nextOffset = i === frameCount - 1 ? 0 : ifdOffset + ifdSize;
    const stripOffset = imageDataOffset + i * frameSizeBytes;

    view.setUint16(ifdOffset, entries, true);
    writeEntry(ifdOffset, 0, 256, 4, 1, width);
    writeEntry(ifdOffset, 1, 257, 4, 1, height);
    writeEntry(ifdOffset, 2, 258, 3, 1, bits);
    writeEntry(ifdOffset, 3, 259, 3, 1, 1);
    writeEntry(ifdOffset, 4, 262, 3, 1, 1);
    writeEntry(ifdOffset, 5, 273, 4, 1, stripOffset);
    writeEntry(ifdOffset, 6, 277, 3, 1, 1);
    writeEntry(ifdOffset, 7, 278, 4, 1, height);
    writeEntry(ifdOffset, 8, 279, 4, 1, frameSizeBytes);
    writeEntry(ifdOffset, 9, 339, 3, 1, sampleFormat);
    view.setUint32(ifdOffset + 2 + entries * 12, nextOffset, true);
  }

  return buffer;
};

export const gzipBuffer = async (
  buffer: ArrayBuffer,
  onProgress?: (progress: number) => void
): Promise<ArrayBuffer> => {
  if (typeof CompressionStream === 'undefined') {
    return buffer;
  }

  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  // Write the data in chunks to allow progress tracking
  const input = new Uint8Array(buffer);
  const chunkSize = 1024 * 1024; // 1MB chunks
  let offset = 0;

  // Start reading compressed data
  const chunks: Uint8Array[] = [];
  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();

  // Write input data in chunks
  while (offset < input.length) {
    const end = Math.min(offset + chunkSize, input.length);
    const chunk = input.slice(offset, end);
    await writer.write(chunk);
    offset = end;

    // Report progress (70% + 0-15% for compression progress)
    if (onProgress) {
      const progress = 70 + Math.floor((offset / input.length) * 15);
      onProgress(progress);
    }
  }

  await writer.close();
  await readPromise;

  // Combine all compressed chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }

  return result.buffer;
};

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const toUint8Array = (input: ArrayBuffer | Uint8Array): Uint8Array =>
  input instanceof Uint8Array ? input : new Uint8Array(input);

const getCrc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const encodeUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const buildZipBuffer = (
  files: { name: string; data: ArrayBuffer | Uint8Array }[]
): ArrayBuffer => {
  const normalized = files.map(file => {
    const nameBytes = encodeUtf8(file.name);
    const dataBytes = toUint8Array(file.data);
    const crc32 = getCrc32(dataBytes);
    return {
      name: file.name,
      nameBytes,
      dataBytes,
      crc32,
      compressedSize: dataBytes.length,
      uncompressedSize: dataBytes.length,
    };
  });

  const localHeadersSize = normalized.reduce(
    (sum, file) => sum + 30 + file.nameBytes.length + file.dataBytes.length,
    0
  );
  const centralDirectorySize = normalized.reduce(
    (sum, file) => sum + 46 + file.nameBytes.length,
    0
  );
  const endOfCentralDirectorySize = 22;
  const totalSize = localHeadersSize + centralDirectorySize + endOfCentralDirectorySize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  let offset = 0;
  const localHeaderOffsets: number[] = [];

  normalized.forEach(file => {
    localHeaderOffsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint32(offset + 14, file.crc32, true);
    view.setUint32(offset + 18, file.compressedSize, true);
    view.setUint32(offset + 22, file.uncompressedSize, true);
    view.setUint16(offset + 26, file.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    offset += 30;

    out.set(file.nameBytes, offset);
    offset += file.nameBytes.length;

    out.set(file.dataBytes, offset);
    offset += file.dataBytes.length;
  });

  const centralDirectoryOffset = offset;

  normalized.forEach((file, index) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, 0, true);
    view.setUint32(offset + 16, file.crc32, true);
    view.setUint32(offset + 20, file.compressedSize, true);
    view.setUint32(offset + 24, file.uncompressedSize, true);
    view.setUint16(offset + 28, file.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, localHeaderOffsets[index], true);
    offset += 46;

    out.set(file.nameBytes, offset);
    offset += file.nameBytes.length;
  });

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, normalized.length, true);
  view.setUint16(offset + 10, normalized.length, true);
  view.setUint32(offset + 12, centralDirectorySize, true);
  view.setUint32(offset + 16, centralDirectoryOffset, true);
  view.setUint16(offset + 20, 0, true);

  return buffer;
};
