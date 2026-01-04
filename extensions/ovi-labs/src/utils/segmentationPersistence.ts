import { openDB } from 'idb';

const DB_NAME = 'oviLabsSegmentation';
const STORE_NAME = 'segmentations';
const DB_VERSION = 1;

interface StoredSegmentation {
  id: string;
  seriesInstanceUID: string;
  model: string;
  frameKey: string;
  width: number;
  height: number;
  maskData: Uint8Array;
  labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }>;
  updatedAt: number;
}

const getDb = () =>
  openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    },
  });

export const saveSegmentationFrame = async (payload: Omit<StoredSegmentation, 'id'>) => {
  const db = await getDb();
  const id = `${payload.seriesInstanceUID}:${payload.model}:${payload.frameKey}`;
  await db.put(STORE_NAME, { ...payload, id });
};

export const loadSegmentationFrames = async (seriesInstanceUID: string) => {
  const db = await getDb();
  const allEntries = await db.getAll(STORE_NAME);
  return allEntries.filter((entry: StoredSegmentation) => entry.seriesInstanceUID === seriesInstanceUID);
};
