/**
 * Regression test: MedEx segmentation auto-load workflow
 *
 * Verifies that:
 *   1. No double-restore race condition (SEGMENTATION_ADDED phase guard works)
 *   2. Viewport screenshot matches baseline once segmentation fully loads
 *
 * Run against a local dev server (`yarn dev`) or the deployed instance.
 * First run: use --update-snapshots to create baseline screenshots.
 */

import { test, expect } from 'playwright-test-coverage';
import { loginAs, checkForScreenshot, screenShotPaths } from './utils';

const STUDY_UID = '2.25.923096752237823522504815513406976806917';
const AUTO_LOAD_TIMEOUT_MS = 60_000;

const installSegAutoLoadProbe = async page => {
  await page.addInitScript(() => {
    (window as any).__segAutoLoadDone = false;
    (window as any).__segPixelsRestored = null;

    const orig = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      orig(...args);

      if (typeof args[0] !== 'string') {
        return;
      }

      if (args[0].includes('autoCreate:pixels-restored')) {
        (window as any).__segPixelsRestored = args[1] ?? {};
      }

      if (args[0].includes('autoCreate:EXIT-success')) {
        (window as any).__segAutoLoadDone = true;
      }
    };
  });
};

const waitForSegAutoLoad = async page => {
  await page.waitForFunction(() => (window as any).__segAutoLoadDone === true, {
    timeout: AUTO_LOAD_TIMEOUT_MS,
  });

  const restoreStats = await page.evaluate(() => (window as any).__segPixelsRestored);
  const restoredFrameCount =
    (restoreStats?.modifiedIndices?.length || 0) +
    (restoreStats?.restoredTimePoints?.length || 0);

  expect(
    restoredFrameCount,
    `Expected auto-load to restore non-empty backend frames; stats: ${JSON.stringify(restoreStats)}`
  ).toBeGreaterThan(0);

  return restoreStats;
};

const getSegmentationPanelState = async page => {
  return page.evaluate(() => {
    const isVisible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const addSpan = Array.from(document.querySelectorAll('span')).find(
      span => span.textContent?.trim() === 'Add Segmentation' && isVisible(span)
    );
    const addRow = addSpan?.closest('.group');
    const parent = addRow?.parentElement ?? null;
    const siblings = parent ? Array.from(parent.children) : [];
    const addIndex = addRow ? siblings.indexOf(addRow) : -1;
    const textBeforeAdd =
      addIndex >= 0
        ? siblings
            .slice(0, addIndex)
            .map(element => element.textContent ?? '')
            .join('\n')
        : '';

    const visibleLabels = Array.from(document.querySelectorAll('.segmentation-expanded-section'))
      .filter(isVisible)
      .map(element => element.textContent?.trim() ?? '')
      .filter(Boolean);

    const parseRgb = (value: string | null) => {
      const match = value?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };

    const segmentCards = Array.from(document.querySelectorAll<HTMLElement>('div[style]'))
      .filter(element => {
        const text = element.textContent ?? '';
        const style = window.getComputedStyle(element);
        return isVisible(element) && /Opacity|Annotated Slice|Annotated Frame/i.test(text) && parseRgb(style.borderColor);
      })
      .map(element => {
        const style = window.getComputedStyle(element);
        return {
          text: element.textContent?.trim() ?? '',
          borderColor: style.borderColor,
          rgb: parseRgb(style.borderColor),
        };
      });

    return {
      addSegmentationVisible: Boolean(addSpan),
      textBeforeAdd,
      visibleLabels,
      segmentCards,
      hasSegmentationCard:
        /Segmentation/i.test(textBeforeAdd) ||
        visibleLabels.some(text => /Segmentation|Segment\s*\d+/i.test(text)) ||
        segmentCards.length > 0,
    };
  });
};

const getCanvasColorStats = async (page, expectedColors: number[][]) => {
  return page.locator('canvas.cornerstone-canvas').first().evaluate((canvas, colors) => {
    if (!(canvas instanceof HTMLCanvasElement)) {
      return { width: 0, height: 0, chromaticPixels: 0, sampledPixels: 0, colorMatches: [] };
    }

    const colorChroma = colors
      .map(color => {
        const gray = (color[0] + color[1] + color[2]) / 3;
        const vector = [color[0] - gray, color[1] - gray, color[2] - gray];
        const magnitude = Math.hypot(vector[0], vector[1], vector[2]);
        return { rgb: color, vector, magnitude, matchedPixels: 0 };
      })
      .filter(color => color.magnitude > 0);

    const sourceWidth = canvas.width;
    const sourceHeight = canvas.height;
    const sampleWidth = Math.min(sourceWidth, 360);
    const sampleHeight = Math.min(sourceHeight, 360);
    const target = document.createElement('canvas');
    target.width = sampleWidth;
    target.height = sampleHeight;

    const context = target.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return { width: sourceWidth, height: sourceHeight, chromaticPixels: 0, sampledPixels: 0 };
    }

    context.drawImage(canvas, 0, 0, sourceWidth, sourceHeight, 0, 0, sampleWidth, sampleHeight);
    const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
    let chromaticPixels = 0;
    let sampledPixels = 0;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) {
        continue;
      }

      const red = data[i];
      const green = data[i + 1];
      const blue = data[i + 2];
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      sampledPixels += 1;

      if (max <= 70 || max - min <= 24) {
        continue;
      }

      chromaticPixels += 1;

      const gray = (red + green + blue) / 3;
      const pixelVector = [red - gray, green - gray, blue - gray];
      const pixelMagnitude = Math.hypot(pixelVector[0], pixelVector[1], pixelVector[2]);

      if (pixelMagnitude <= 18) {
        continue;
      }

      for (const color of colorChroma) {
        const similarity =
          (pixelVector[0] * color.vector[0] +
            pixelVector[1] * color.vector[1] +
            pixelVector[2] * color.vector[2]) /
          (pixelMagnitude * color.magnitude);

        if (similarity > 0.82) {
          color.matchedPixels += 1;
        }
      }
    }

    const colorMatches = colorChroma.map(color => ({
      rgb: color.rgb,
      matchedPixels: color.matchedPixels,
    }));
    const expectedColorPixels = colorMatches.reduce(
      (sum, color) => sum + color.matchedPixels,
      0
    );

    return {
      width: sourceWidth,
      height: sourceHeight,
      chromaticPixels,
      expectedColorPixels,
      sampledPixels,
      colorMatches,
    };
  }, expectedColors);
};

const getSegmentationDebugState = async page => {
  return page.evaluate(() => {
    const cs = (window as any).cornerstone;
    const csTools = (window as any).cornerstoneTools;
    const elements = cs?.getEnabledElements?.() ?? [];

    let actors: unknown[] = [];
    try {
      actors = elements.flatMap((element: any) =>
        (element.viewport?.getActors?.() ?? []).map((actor: any) => ({
          uid: actor.uid,
          referencedId: actor.referencedId,
          blendMode: actor.blendMode,
          keys: Object.keys(actor),
        }))
      );
    } catch (error) {
      actors = [{ error: error instanceof Error ? error.message : String(error) }];
    }

    let toolState: unknown = null;
    try {
      const state = csTools?.segmentation?.state;
      const segmentations = state?.getSegmentations?.() ?? state?.getAllSegmentations?.() ?? [];
      toolState = segmentations.map((segmentation: any) => ({
        segmentationId: segmentation.segmentationId,
        label: segmentation.label,
        segmentCount: Object.keys(segmentation.segments ?? {}).length,
        representationData: Object.keys(segmentation.representationData ?? {}),
      }));
    } catch (error) {
      toolState = { error: error instanceof Error ? error.message : String(error) };
    }

    return {
      actorCount: actors.length,
      actors,
      toolState,
    };
  });
};

test.describe('MedEx segmentation auto-load', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('no double-restore: phase guard prevents concurrent restoreFrames', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__restoreCallers = [];
      const orig = console.log.bind(console);
      console.log = (...args: unknown[]) => {
        orig(...args);
        if (typeof args[0] === 'string' && args[0].includes('restoreFrames:ENTER')) {
          const data = args[1] as { caller?: string } | undefined;
          (window as any).__restoreCallers.push(data?.caller ?? 'unknown');
        }
      };
    });

    await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${STUDY_UID}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(AUTO_LOAD_TIMEOUT_MS / 3);

    const callers: string[] = await page.evaluate(() => (window as any).__restoreCallers ?? []);
    const spurious = callers.filter(c => c === 'SEGMENTATION_ADDED');
    expect(
      spurious.length,
      `Race condition: restoreFrames called ${spurious.length}x from SEGMENTATION_ADDED (callers: ${JSON.stringify(callers)})`
    ).toBe(0);
  });

  test('viewport renders segmentation overlay after auto-load completes', async ({ page }) => {
    await installSegAutoLoadProbe(page);

    await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${STUDY_UID}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle');

    await waitForSegAutoLoad(page);

    await page.waitForFunction(
      () => {
        const parseRgb = (value: string | null) => value?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        const isVisible = (element: Element | null) => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }

          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        return Array.from(document.querySelectorAll<HTMLElement>('div[style]')).some(element => {
          const text = element.textContent ?? '';
          const style = window.getComputedStyle(element);
          return (
            isVisible(element) &&
            /Opacity|Annotated Slice|Annotated Frame/i.test(text) &&
            Boolean(parseRgb(style.borderColor))
          );
        });
      },
      { timeout: AUTO_LOAD_TIMEOUT_MS }
    );

    const panelState = await getSegmentationPanelState(page);
    expect(
      panelState.hasSegmentationCard,
      `Expected segmentation table to show saved segment cards before/near Add Segmentation; panel: ${JSON.stringify(panelState)} debug: ${JSON.stringify(await getSegmentationDebugState(page))}`
    ).toBe(true);

    const expectedColors = panelState.segmentCards
      .map(card => card.rgb)
      .filter((rgb): rgb is number[] => Array.isArray(rgb) && rgb.length === 3);
    expect(
      expectedColors.length,
      `Expected segment cards to expose color IDs for rendered labels; state: ${JSON.stringify(panelState)}`
    ).toBeGreaterThan(0);

    // Extra settle time for the GPU to composite the labelmap onto the canvas
    await page.waitForTimeout(1000);

    const colorStats = await getCanvasColorStats(page, expectedColors);
    expect(
      colorStats.expectedColorPixels,
      `Expected viewport canvas pixels to match the segment card colors; panel: ${JSON.stringify(panelState)} canvas: ${JSON.stringify(colorStats)} debug: ${JSON.stringify(await getSegmentationDebugState(page))}`
    ).toBeGreaterThan(50);

    // Screenshot the viewport canvas — baseline created on first run with --update-snapshots
    const canvas = page.locator('canvas.cornerstone-canvas').first();
    await checkForScreenshot(
      page,
      canvas,
      screenShotPaths.medexSegAutoLoad.viewportWithSegmentation
    );
  });
});
