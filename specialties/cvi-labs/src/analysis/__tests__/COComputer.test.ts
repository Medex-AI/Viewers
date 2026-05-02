import { COComputer } from '../COComputer';

// Mock @cornerstonejs/core metaData
jest.mock('@cornerstonejs/core', () => ({
  metaData: {
    get: jest.fn(),
  },
}));

import { metaData } from '@cornerstonejs/core';
const mockMetaData = metaData as jest.Mocked<typeof metaData>;

const FAKE_IMAGE_ID = 'wadors:http://orthanc/dicom/series/001/instances/001/frames/1';

describe('COComputer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('DICOM tag (0018,1088) present', () => {
    it('returns HR from tag with source dicom', () => {
      mockMetaData.get.mockImplementation((type: string) => {
        if (type === 'instance') return { x00181088: '72' };
        return {};
      });
      const result = COComputer.extractHR(FAKE_IMAGE_ID);
      expect(result.heartRateBpm).toBe(72);
      expect(result.source).toBe('dicom');
    });

    it('parses string numeric HR values', () => {
      mockMetaData.get.mockImplementation((type: string) => {
        if (type === 'instance') return { x00181088: '65.5' };
        return {};
      });
      const result = COComputer.extractHR(FAKE_IMAGE_ID);
      expect(result.heartRateBpm).toBeCloseTo(65.5, 1);
    });
  });

  describe('derived from TR × CardiacNumberOfImages', () => {
    it('computes HR from TR and CardiacNumImages', () => {
      mockMetaData.get.mockImplementation((type: string) => {
        if (type === 'instance') return { x00180080: '25', x00181090: '25' }; // TR=25ms, 25 frames
        return {};
      });
      const result = COComputer.extractHR(FAKE_IMAGE_ID);
      // HR = 60000 / (25 × 25) = 96 bpm
      expect(result.heartRateBpm).toBeCloseTo(96, 0);
      expect(result.source).toBe('derived');
    });

    it('returns null when TR is missing', () => {
      mockMetaData.get.mockImplementation((type: string) => {
        if (type === 'instance') return { x00181090: '30' };
        return {};
      });
      const result = COComputer.extractHR(FAKE_IMAGE_ID);
      expect(result.heartRateBpm).toBeNull();
      expect(result.source).toBeNull();
    });

    it('returns null when CardiacNumImages is missing', () => {
      mockMetaData.get.mockImplementation((type: string) => {
        if (type === 'instance') return { x00180080: '40' };
        return {};
      });
      const result = COComputer.extractHR(FAKE_IMAGE_ID);
      expect(result.heartRateBpm).toBeNull();
    });
  });

  describe('all tags absent', () => {
    it('returns null HR with null source', () => {
      mockMetaData.get.mockReturnValue({});
      const result = COComputer.extractHR(FAKE_IMAGE_ID);
      expect(result.heartRateBpm).toBeNull();
      expect(result.source).toBeNull();
    });
  });

  describe('computeCO', () => {
    it('computes CO = SV_mL × HR_bpm / 1000 in L/min', () => {
      // SV = 80 mL, HR = 72 bpm → CO = 80 × 72 / 1000 = 5.76 L/min
      expect(COComputer.computeCO(80, 72)).toBeCloseTo(5.76, 2);
    });

    it('handles fractional values', () => {
      expect(COComputer.computeCO(75.5, 68)).toBeCloseTo(5.134, 2);
    });

    it('returns 0 for zero SV', () => {
      expect(COComputer.computeCO(0, 72)).toBe(0);
    });
  });

  describe('priority: DICOM tag beats derived', () => {
    it('uses DICOM tag when both tag and TR/CardiacNumImages present', () => {
      mockMetaData.get.mockImplementation((type: string) => {
        if (type === 'instance') {
          return { x00181088: '60', x00180080: '25', x00181090: '25' };
        }
        return {};
      });
      const result = COComputer.extractHR(FAKE_IMAGE_ID);
      expect(result.heartRateBpm).toBe(60);
      expect(result.source).toBe('dicom');
    });
  });
});
