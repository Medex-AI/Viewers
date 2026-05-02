import { VolumeComputer, SliceMasks } from '../VolumeComputer';

describe('VolumeComputer', () => {
  describe('single-slice approximation', () => {
    it('computes volume as area × sliceThickness', () => {
      const sliceMasks: SliceMasks[] = [
        [{ frameIndex: 0, areaMm2: 1000 }],
      ];
      const result = VolumeComputer.computeVolumeSeries(sliceMasks, 8);
      expect(result[0]).toBeCloseTo(8.0, 2); // 1000 mm² × 8 mm / 1000 = 8 mL
    });

    it('returns 0 for all-zero masks', () => {
      const sliceMasks: SliceMasks[] = [
        [{ frameIndex: 0, areaMm2: 0 }],
      ];
      const result = VolumeComputer.computeVolumeSeries(sliceMasks, 8);
      expect(result[0]).toBe(0);
    });
  });

  describe('multi-slice Simpson aggregation', () => {
    it('sums areas across slices × spacing', () => {
      const sliceMasks: SliceMasks[] = [
        [{ frameIndex: 0, areaMm2: 100 }],
        [{ frameIndex: 0, areaMm2: 120 }],
      ];
      const result = VolumeComputer.computeVolumeSeries(sliceMasks, 8);
      // (100 + 120) × 8 / 1000 = 1.76 mL
      expect(result[0]).toBeCloseTo(1.76, 2);
    });

    it('handles slices with different frame coverage', () => {
      // slice 0 has frames 0 and 1; slice 1 has only frame 0
      const sliceMasks: SliceMasks[] = [
        [
          { frameIndex: 0, areaMm2: 200 },
          { frameIndex: 1, areaMm2: 180 },
        ],
        [{ frameIndex: 0, areaMm2: 220 }],
      ];
      const result = VolumeComputer.computeVolumeSeries(sliceMasks, 6);
      // frame 0: (200 + 220) × 6 / 1000 = 2.52 mL
      expect(result[0]).toBeCloseTo(2.52, 2);
      // frame 1: (180 + 0) × 6 / 1000 = 1.08 mL
      expect(result[1]).toBeCloseTo(1.08, 2);
    });

    it('returns empty array for empty input', () => {
      expect(VolumeComputer.computeVolumeSeries([], 8)).toEqual([]);
    });

    it('handles 3 slices correctly', () => {
      const sliceMasks: SliceMasks[] = [
        [{ frameIndex: 0, areaMm2: 500 }],
        [{ frameIndex: 0, areaMm2: 600 }],
        [{ frameIndex: 0, areaMm2: 400 }],
      ];
      const result = VolumeComputer.computeVolumeSeries(sliceMasks, 10);
      // (500 + 600 + 400) × 10 / 1000 = 15 mL
      expect(result[0]).toBeCloseTo(15.0, 2);
    });
  });

  describe('frame index alignment', () => {
    it('returns volume indexed by frameIndex', () => {
      const sliceMasks: SliceMasks[] = [
        [
          { frameIndex: 2, areaMm2: 300 },
          { frameIndex: 5, areaMm2: 250 },
        ],
      ];
      const result = VolumeComputer.computeVolumeSeries(sliceMasks, 8);
      expect(result[2]).toBeCloseTo(2.4, 2);  // 300 × 8 / 1000
      expect(result[5]).toBeCloseTo(2.0, 2);  // 250 × 8 / 1000
      expect(result[0]).toBe(0);
    });
  });
});
