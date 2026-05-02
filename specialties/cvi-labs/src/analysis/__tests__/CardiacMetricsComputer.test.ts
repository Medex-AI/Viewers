import { CardiacMetricsComputer } from '../CardiacMetricsComputer';

describe('CardiacMetricsComputer', () => {
  describe('full cycle', () => {
    it('computes EF, EDV, ESV, SV correctly', () => {
      // EDV = 150 mL, ESV = 60 mL → SV = 90, EF = 60.0%
      const lvSeries = [120, 135, 150, 140, 110, 80, 60, 70, 90, 110, 130, 145];
      const result = CardiacMetricsComputer.compute(lvSeries);
      expect(result.edvMl).toBeCloseTo(150, 1);
      expect(result.esvMl).toBeCloseTo(60, 1);
      expect(result.strokeVolumeMl).toBeCloseTo(90, 1);
      expect(result.ef).toBeCloseTo(60.0, 1);
    });

    it('rounds EF to one decimal place', () => {
      // EDV = 100, ESV = 33 → EF = 67.0%
      const lvSeries = [100, 80, 60, 40, 33, 45, 65, 85];
      const result = CardiacMetricsComputer.compute(lvSeries);
      const expected = ((100 - 33) / 100) * 100;
      expect(result.ef).toBeCloseTo(parseFloat(expected.toFixed(1)), 1);
    });
  });

  describe('insufficient data', () => {
    it('returns all nulls for empty series', () => {
      const result = CardiacMetricsComputer.compute([]);
      expect(result.ef).toBeNull();
      expect(result.edvMl).toBeNull();
      expect(result.esvMl).toBeNull();
      expect(result.strokeVolumeMl).toBeNull();
    });

    it('returns all nulls for single frame', () => {
      const result = CardiacMetricsComputer.compute([100]);
      expect(result.ef).toBeNull();
      expect(result.edvMl).toBeNull();
    });

    it('returns values for exactly two frames', () => {
      const result = CardiacMetricsComputer.compute([120, 50]);
      expect(result.edvMl).toBeCloseTo(120, 1);
      expect(result.esvMl).toBeCloseTo(50, 1);
      expect(result.ef).toBeCloseTo(58.3, 1);
    });
  });

  describe('edge cases', () => {
    it('handles all-zero series', () => {
      const result = CardiacMetricsComputer.compute([0, 0, 0, 0]);
      // EDV = ESV = 0 → EF division by zero → null
      expect(result.ef).toBeNull();
    });

    it('preserves wallThicknessMm from existing interface as null', () => {
      const result = CardiacMetricsComputer.compute([100, 50]);
      expect(result.wallThicknessMm).toBeNull();
    });
  });
});
