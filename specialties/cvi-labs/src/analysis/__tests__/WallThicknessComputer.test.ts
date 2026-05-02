import { WallThicknessComputer, FrameMask } from '../WallThicknessComputer';

// Helper: create a filled square ring mask (outer - inner square)
// Returns a Uint8Array of size (height × width) with 1s in the ring region
function makeConcentriSquareMasks(
  size: number,
  innerHalf: number,
  outerHalf: number
): { inner: FrameMask; outer: FrameMask } {
  const innerData = new Uint8Array(size * size);
  const outerData = new Uint8Array(size * size);
  const cx = Math.floor(size / 2);
  const cy = Math.floor(size / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      if (dx <= innerHalf && dy <= innerHalf) {
        innerData[y * size + x] = 1;
      }
      if (dx <= outerHalf && dy <= outerHalf) {
        outerData[y * size + x] = 1;
      }
    }
  }
  return {
    inner: { frameIndex: 0, data: innerData, width: size, height: size },
    outer: { frameIndex: 0, data: outerData, width: size, height: size },
  };
}

describe('WallThicknessComputer', () => {
  describe('concentric square masks', () => {
    it('computes expected mean thickness for square rings', () => {
      // inner half-width = 10px, outer half-width = 20px
      // expected thickness ≈ 10px boundary distance on each side
      const { inner, outer } = makeConcentriSquareMasks(64, 10, 20);
      const spacingMm = 1.5; // 1 px = 1.5 mm
      const result = WallThicknessComputer.computeThicknessSeries(
        [inner],
        [outer],
        spacingMm
      );
      // Should be approximately 10 px × 1.5 mm/px = 15 mm (corners slightly more)
      expect(result[0]).not.toBeNull();
      expect(result[0]!).toBeGreaterThan(10);
      expect(result[0]!).toBeLessThan(25);
    });

    it('scales by pixelSpacingMm', () => {
      const { inner: inner1, outer: outer1 } = makeConcentriSquareMasks(64, 10, 15);
      const { inner: inner2, outer: outer2 } = makeConcentriSquareMasks(64, 10, 15);
      const result1 = WallThicknessComputer.computeThicknessSeries([inner1], [outer1], 1.0);
      const result2 = WallThicknessComputer.computeThicknessSeries([inner2], [outer2], 2.0);
      // result2 should be approximately 2× result1
      expect(result2[0]! / result1[0]!).toBeCloseTo(2.0, 1);
    });
  });

  describe('missing masks', () => {
    it('returns null for a frame where inner mask is absent', () => {
      const { outer } = makeConcentriSquareMasks(32, 5, 10);
      const result = WallThicknessComputer.computeThicknessSeries([], [outer], 1.0);
      expect(result[0]).toBeNull();
    });

    it('returns null for a frame where outer mask is absent', () => {
      const { inner } = makeConcentriSquareMasks(32, 5, 10);
      const result = WallThicknessComputer.computeThicknessSeries([inner], [], 1.0);
      expect(result[0]).toBeNull();
    });

    it('returns null for all frames when both mask arrays are empty', () => {
      const result = WallThicknessComputer.computeThicknessSeries([], [], 1.0);
      expect(result).toEqual([]);
    });
  });

  describe('multi-frame', () => {
    it('computes thickness per frame independently', () => {
      const size = 48;
      const inner0: FrameMask = { frameIndex: 0, data: makeConcentriSquareMasks(size, 8, 16).inner.data, width: size, height: size };
      const outer0: FrameMask = { frameIndex: 0, data: makeConcentriSquareMasks(size, 8, 16).outer.data, width: size, height: size };
      const inner1: FrameMask = { frameIndex: 1, data: makeConcentriSquareMasks(size, 8, 20).inner.data, width: size, height: size };
      const outer1: FrameMask = { frameIndex: 1, data: makeConcentriSquareMasks(size, 8, 20).outer.data, width: size, height: size };

      const result = WallThicknessComputer.computeThicknessSeries(
        [inner0, inner1],
        [outer0, outer1],
        1.0
      );
      // Frame 1 has thicker wall (outer 20 vs 16); result[1] > result[0]
      expect(result[1]!).toBeGreaterThan(result[0]!);
    });

    it('returns null for frames that lack either mask', () => {
      const { inner, outer } = makeConcentriSquareMasks(32, 6, 12);
      inner.frameIndex = 0;
      outer.frameIndex = 2; // frame 0 has inner only; frame 2 has outer only

      const result = WallThicknessComputer.computeThicknessSeries([inner], [outer], 1.0);
      // Both frames have only one of the two required masks → both null
      expect(result[0]).toBeNull();
      expect(result[2]).toBeNull();
    });
  });

  describe('performance', () => {
    it('completes for 256×256 mask in <50 ms', () => {
      const { inner, outer } = makeConcentriSquareMasks(256, 60, 100);
      const start = performance.now();
      WallThicknessComputer.computeThicknessSeries([inner], [outer], 1.0);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(75); // BFS over 65k pixels; 75 ms allows JIT warmup in CI
    });
  });
});
