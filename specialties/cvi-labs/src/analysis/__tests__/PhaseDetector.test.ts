import { PhaseDetector } from '../PhaseDetector';

describe('PhaseDetector', () => {
  describe('normal detection', () => {
    it('detects ED as argmax and ES as argmin', () => {
      const series = [120, 140, 160, 150, 130, 100, 70, 55, 65, 90, 110, 135];
      const result = PhaseDetector.detect(series);
      expect(result.edFrame).toBe(2);  // index of 160
      expect(result.esFrame).toBe(7);  // index of 55
    });

    it('handles series where ED is at index 0', () => {
      const series = [200, 180, 160, 140, 120, 100, 80];
      const result = PhaseDetector.detect(series);
      expect(result.edFrame).toBe(0);
      expect(result.esFrame).toBe(6);
    });

    it('handles series where ES is at last index', () => {
      const series = [100, 120, 150, 140, 130, 110, 90, 70];
      const result = PhaseDetector.detect(series);
      expect(result.edFrame).toBe(2);
      expect(result.esFrame).toBe(7);
    });
  });

  describe('tie-breaking', () => {
    it('returns earlier frame when two frames share max volume (ED)', () => {
      const series = [100, 160, 160, 140, 80];
      const result = PhaseDetector.detect(series);
      expect(result.edFrame).toBe(1);
    });

    it('returns earlier frame when two frames share min volume (ES)', () => {
      const series = [100, 60, 60, 80, 100];
      const result = PhaseDetector.detect(series);
      expect(result.esFrame).toBe(1);
    });
  });

  describe('insufficient data', () => {
    it('returns -1/-1 for empty series', () => {
      expect(PhaseDetector.detect([])).toEqual({ edFrame: -1, esFrame: -1 });
    });

    it('returns -1/-1 for single frame', () => {
      expect(PhaseDetector.detect([100])).toEqual({ edFrame: -1, esFrame: -1 });
    });

    it('returns -1/-1 when all values are zero', () => {
      expect(PhaseDetector.detect([0, 0, 0, 0])).toEqual({ edFrame: -1, esFrame: -1 });
    });

    it('returns -1/-1 when only one frame is non-zero', () => {
      expect(PhaseDetector.detect([0, 0, 100, 0])).toEqual({ edFrame: -1, esFrame: -1 });
    });
  });

  describe('two-frame minimum', () => {
    it('detects ED and ES from exactly two non-zero frames', () => {
      const series = [0, 120, 0, 0, 60, 0];
      const result = PhaseDetector.detect(series);
      expect(result.edFrame).toBe(1);
      expect(result.esFrame).toBe(4);
    });
  });
});
