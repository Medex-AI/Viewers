import { test, expect } from 'playwright-test-coverage';
import { loginAs } from './utils';

const SINGLE_VIEWPORT_STUDY_UID = '2.25.886183689675766305740169196162815250747';
const FOUR_VIEWPORT_STUDY_UID = '1.2.840.113619.186.2403117520819917.20201214214121708.522';
const AUTO_LOAD_TIMEOUT_MS = 60_000;
const STUDY_VIEWPORT_MATRIX = [
  {
    name: 'single-viewport study',
    studyUid: SINGLE_VIEWPORT_STUDY_UID,
    expectedCanvasCount: 1,
    viewportOrdinals: [0],
  },
  {
    name: 'four-viewport study',
    studyUid: FOUR_VIEWPORT_STUDY_UID,
    expectedCanvasCount: 4,
    viewportOrdinals: [0, 1, 2, 3],
  },
];

const rgbToHex = (rgb: number[]) =>
  `#${rgb
    .slice(0, 3)
    .map(value => Math.round(value).toString(16).padStart(2, '0'))
    .join('')}`;

const blockSegmentationWrites = async page => {
  const blocked: string[] = [];
  const escaped: string[] = [];

  page.on('response', response => {
    const request = response.request();
    if (
      request.method() !== 'GET' &&
      request.url().includes('segmentation-frames') &&
      response.headers()['x-playwright-segmentation-write-blocked'] !== 'true'
    ) {
      escaped.push(`${request.method()} ${request.url()} -> ${response.status()}`);
    }
  });

  await page.route('**/*segmentation-frames**', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.continue();
      return;
    }

    blocked.push(`${request.method()} ${request.url()}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'x-playwright-segmentation-write-blocked': 'true',
      },
      body: '{}',
    });
  });

  await page.addInitScript(() => {
    const originalSendBeacon = navigator.sendBeacon?.bind(navigator);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (url: string | URL, data?: BodyInit | null) => {
        const href = String(url);
        if (href.includes('/api/segmentation-frames')) {
          (window as any).__blockedSegmentationBeacons =
            ((window as any).__blockedSegmentationBeacons || 0) + 1;
          return true;
        }
        return originalSendBeacon?.(url, data) ?? false;
      },
    });
  });

  return { blocked, escaped };
};

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
    (restoreStats?.modifiedIndices?.length || 0) + (restoreStats?.restoredTimePoints?.length || 0);

  expect(
    restoredFrameCount,
    `Expected auto-load to restore backend frames before contour test; stats: ${JSON.stringify(restoreStats)}`
  ).toBeGreaterThan(0);
};

const waitForSegmentCards = async page => {
  await page.waitForFunction(
    () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('div.flex.overflow-hidden.rounded-md.border[style]')
      ).some(element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          /Opacity|Annotated Slice|Annotated Frame/i.test(element.textContent ?? '') &&
          /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.test(style.borderColor)
        );
      }),
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
};

const waitForViewportCount = async (page, minimumCount: number) => {
  await page.waitForFunction(
    count =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-cy="viewport-pane"]')).filter(
        element => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        }
      ).length >= count,
    minimumCount,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
};

const getActiveSegmentCardColor = async page => {
  return page.evaluate(() => {
    const parseRgb = (value: string | null) => {
      const match = value?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };

    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('div.flex.overflow-hidden.rounded-md.border[style]')
    )
      .map(element => {
        const style = window.getComputedStyle(element);
        return {
          text: element.textContent ?? '',
          borderColor: style.borderColor,
          boxShadow: style.boxShadow,
          rgb: parseRgb(style.borderColor),
        };
      })
      .filter(card => /Opacity|Annotated Slice|Annotated Frame/i.test(card.text) && card.rgb);

    return (
      cards.find(card => card.boxShadow && card.boxShadow !== 'none')?.rgb || cards[0]?.rgb || null
    );
  });
};

const getColorDebugState = async page => {
  return page.evaluate(() => {
    const cornerstoneTools = (window as any).cornerstoneTools;
    const segmentations =
      cornerstoneTools?.segmentation?.state?.getSegmentations?.() ??
      cornerstoneTools?.segmentation?.state?.getAllSegmentations?.() ??
      [];
    const segmentation = segmentations[0];
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('div.flex.overflow-hidden.rounded-md.border[style]')
    ).map(element => {
      const style = window.getComputedStyle(element);
      return {
        text: element.textContent,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
      };
    });
    return {
      activeContourColor: (window as any).__oviActiveManualContourColor,
      segmentation: {
        label: segmentation?.label,
        segments: segmentation?.segments,
      },
      cards,
    };
  });
};

const getVisibleSegmentCardColors = async page => {
  return page.evaluate(() => {
    const parseRgb = (value: string | null) => {
      const match = value?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };

    return Array.from(
      document.querySelectorAll<HTMLElement>('div.flex.overflow-hidden.rounded-md.border[style]')
    )
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          index,
          text: element.textContent ?? '',
          rgb: parseRgb(style.borderColor),
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden',
        };
      })
      .filter(
        card =>
          card.visible && card.rgb && /Opacity|Annotated Slice|Annotated Frame/i.test(card.text)
      );
  });
};

const addInMemorySegmentClass = async (
  page,
  {
    label,
    color,
  }: {
    label: string;
    color: [number, number, number, number];
  }
) => {
  return page.evaluate(
    ({ label, color }) => {
      const services = (window as any).services;
      const { segmentationService, viewportGridService } = services || {};
      const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
      const activeSegmentation = activeViewportId
        ? segmentationService?.getActiveSegmentation?.(activeViewportId)
        : null;

      if (!activeViewportId || !activeSegmentation?.segmentationId) {
        throw new Error(
          `No active segmentation was available for in-memory test segment: ${JSON.stringify({
            activeViewportId,
            activeSegmentation,
          })}`
        );
      }

      segmentationService.addSegment(activeSegmentation.segmentationId, {
        label,
        color,
        active: true,
        visibility: true,
      });

      return {
        activeViewportId,
        segmentationId: activeSegmentation.segmentationId,
      };
    },
    { label, color }
  );
};

const getManualContourColorState = async page => {
  return page.evaluate(() => {
    const cornerstoneTools = (window as any).cornerstoneTools;
    const toolGroupIds = cornerstoneTools?.ToolGroupManager?.getAllToolGroups?.()
      ?.map(toolGroup => toolGroup.id)
      ?.filter(Boolean) ?? ['default', 'mpr', 'volume3d'];
    const toolGroupStyles = toolGroupIds.reduce(
      (acc, toolGroupId) => {
        const styles =
          cornerstoneTools?.annotation?.config?.style?.getToolGroupToolStyles?.(toolGroupId) || {};
        acc[toolGroupId] = styles.ManualContour || null;
        return acc;
      },
      {} as Record<string, unknown>
    );

    return {
      activeContourColor: (window as any).__oviActiveManualContourColor,
      toolGroupIds,
      toolGroupStyles,
    };
  });
};

const expectManualContourColor = async (page, expectedHex: string) => {
  const normalizedExpectedHex = expectedHex.toLowerCase();

  await page.waitForFunction(
    expected => (window as any).__oviActiveManualContourColor?.toLowerCase() === expected,
    normalizedExpectedHex,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );

  const colorState = await getManualContourColorState(page);
  expect(
    colorState.activeContourColor?.toLowerCase(),
    `Expected contour color variable to match active segment; ${JSON.stringify(colorState)}`
  ).toBe(normalizedExpectedHex);

  for (const [toolGroupId, style] of Object.entries(colorState.toolGroupStyles)) {
    expect(
      (style as any)?.color?.toLowerCase(),
      `Expected ManualContour line color for tool group ${toolGroupId}; ${JSON.stringify(colorState)}`
    ).toBe(normalizedExpectedHex);
  }
};

const dispatchContourTrajectory = async (
  page,
  mode: 'draw' | 'erase',
  sizeFraction: number,
  canvasIndex = 0
) => {
  return page.evaluate(
    async ({ mode, sizeFraction, canvasIndex }) => {
      const cornerstone = (window as any).cornerstone;
      const enabledElement = cornerstone?.getEnabledElements?.()[canvasIndex];
      const viewport = enabledElement?.viewport;
      const element = enabledElement?.element || viewport?.element;
      const testApi = (window as any).__medexSegmentationTestApi;

      if (!viewport || !element || !testApi?.completeManualContour) {
        throw new Error(
          `Segmentation contour test API was not available: ${JSON.stringify({
            hasViewport: Boolean(viewport),
            hasElement: Boolean(element),
            apiType: typeof testApi,
            medexKeys: Object.keys(window).filter(key => key.toLowerCase().includes('medex')),
          })}`
        );
      }

      const canvas = element.querySelector('canvas.cornerstone-canvas') as HTMLCanvasElement | null;
      if (!canvas) {
        throw new Error('Cornerstone canvas was not available');
      }

      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      const cx = width * 0.52;
      const cy = height * 0.48;
      const rx = width * sizeFraction;
      const ry = height * sizeFraction;
      const canvasPoints = [
        [cx - rx, cy - ry],
        [cx + rx, cy - ry],
        [cx + rx, cy + ry],
        [cx - rx, cy + ry],
        [cx - rx, cy - ry],
      ];
      const worldPolyline = canvasPoints.map(point => viewport.canvasToWorld(point));
      const imageIds = viewport.getImageIds?.() ?? [];
      const imageIndex = viewport.getCurrentImageIdIndex?.() ?? 0;
      const referencedImageId = imageIds[imageIndex] || imageIds[0];

      (window as any).__medexManualContourMode = mode;

      const result = await testApi.completeManualContour({
        viewportId: viewport.id,
        referencedImageId,
        worldPolyline,
        mode,
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      return { referencedImageId, canvasPoints, worldPolyline, result };
    },
    { mode, sizeFraction, canvasIndex }
  );
};

const getCanvasColorStats = async (page, canvasIndex: number, expectedRgb: number[]) => {
  return page
    .locator('canvas.cornerstone-canvas')
    .nth(canvasIndex)
    .evaluate((canvas, color) => {
      if (!(canvas instanceof HTMLCanvasElement)) {
        return { width: 0, height: 0, matchedPixels: 0, chromaticPixels: 0 };
      }

      const sourceWidth = canvas.width;
      const sourceHeight = canvas.height;
      const sampleWidth = Math.min(sourceWidth, 360);
      const sampleHeight = Math.min(sourceHeight, 360);
      const target = document.createElement('canvas');
      target.width = sampleWidth;
      target.height = sampleHeight;
      const context = target.getContext('2d', { willReadFrequently: true });
      if (!context) {
        return { width: sourceWidth, height: sourceHeight, matchedPixels: 0, chromaticPixels: 0 };
      }

      context.drawImage(canvas, 0, 0, sourceWidth, sourceHeight, 0, 0, sampleWidth, sampleHeight);
      const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
      const colorGray = (color[0] + color[1] + color[2]) / 3;
      const colorVector = [color[0] - colorGray, color[1] - colorGray, color[2] - colorGray];
      const colorMagnitude = Math.hypot(colorVector[0], colorVector[1], colorVector[2]);
      let matchedPixels = 0;
      let chromaticPixels = 0;

      for (let i = 0; i < data.length; i += 4) {
        const red = data[i];
        const green = data[i + 1];
        const blue = data[i + 2];
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        if (max <= 70 || max - min <= 24) {
          continue;
        }

        chromaticPixels += 1;
        const gray = (red + green + blue) / 3;
        const pixelVector = [red - gray, green - gray, blue - gray];
        const pixelMagnitude = Math.hypot(pixelVector[0], pixelVector[1], pixelVector[2]);
        if (pixelMagnitude <= 18 || colorMagnitude <= 0) {
          continue;
        }

        const similarity =
          (pixelVector[0] * colorVector[0] +
            pixelVector[1] * colorVector[1] +
            pixelVector[2] * colorVector[2]) /
          (pixelMagnitude * colorMagnitude);

        if (similarity > 0.82) {
          matchedPixels += 1;
        }
      }

      return {
        width: sourceWidth,
        height: sourceHeight,
        matchedPixels,
        chromaticPixels,
      };
    }, expectedRgb);
};

const getActiveColorCanvasStats = async (page, expectedRgb: number[]) =>
  getCanvasColorStats(page, 0, expectedRgb);

const getVisibleCanvasCount = async page => {
  return page.locator('canvas.cornerstone-canvas').evaluateAll(
    canvases =>
      canvases.filter(canvas => {
        const rect = canvas.getBoundingClientRect();
        const style = window.getComputedStyle(canvas);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      }).length
  );
};

const getVisibleCanvasOrder = async page => {
  return page.locator('canvas.cornerstone-canvas').evaluateAll(canvases =>
    canvases
      .map((canvas, index) => {
        const rect = canvas.getBoundingClientRect();
        const style = window.getComputedStyle(canvas);
        return {
          index,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden',
        };
      })
      .filter(item => item.visible)
      .sort((a, b) => a.top - b.top || a.left - b.left)
  );
};

const drawBrushStrokeOnCanvas = async (page, canvasIndex: number) => {
  const canvas = page.locator('canvas.cornerstone-canvas').nth(canvasIndex);
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error(`No bounding box for canvas ${canvasIndex}`);
  }

  const target = await canvas.evaluate(canvasElement => {
    const canvas = canvasElement as HTMLCanvasElement;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !canvas.width || !canvas.height) {
      return { x: 0.5, y: 0.5 };
    }

    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    let best = { x: Math.floor(width / 2), y: Math.floor(height / 2), score: -1 };
    const minX = Math.floor(width * 0.15);
    const maxX = Math.floor(width * 0.85);
    const minY = Math.floor(height * 0.15);
    const maxY = Math.floor(height * 0.85);
    const stepX = Math.max(1, Math.floor(width / 120));
    const stepY = Math.max(1, Math.floor(height / 120));

    for (let y = minY; y < maxY; y += stepY) {
      for (let x = minX; x < maxX; x += stepX) {
        const offset = (y * width + x) * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const score = red + green + blue - Math.max(0, max - min) * 3;
        if (max > 35 && score > best.score) {
          best = { x, y, score };
        }
      }
    }

    return {
      x: best.x / width,
      y: best.y / height,
    };
  });

  const startX = box.x + box.width * Math.max(0.08, target.x - 0.06);
  const startY = box.y + box.height * target.y;
  const endX = box.x + box.width * Math.min(0.92, target.x + 0.06);
  const endY = box.y + box.height * target.y;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
};

const stepCanvasSlice = async (page, canvasIndex: number, preferredDelta: 1 | -1 = 1) => {
  return page.evaluate(
    async ({ canvasIndex, preferredDelta }) => {
      const cornerstone = (window as any).cornerstone;
      const enabledElement = (cornerstone?.getEnabledElements?.() ?? [])[canvasIndex];
      const viewport = enabledElement?.viewport;
      const element = enabledElement?.element || viewport?.element;
      const currentIndex = viewport?.getCurrentImageIdIndex?.();
      const totalSlices = viewport?.getNumberOfSlices?.() || viewport?.getImageIds?.()?.length || 0;

      if (!viewport || !element || typeof currentIndex !== 'number' || totalSlices < 2) {
        throw new Error(
          `Cannot step canvas ${canvasIndex}: ${JSON.stringify({
            hasViewport: Boolean(viewport),
            hasElement: Boolean(element),
            currentIndex,
            totalSlices,
          })}`
        );
      }

      const delta =
        preferredDelta > 0 && currentIndex < totalSlices - 1
          ? 1
          : preferredDelta < 0 && currentIndex > 0
            ? -1
            : currentIndex > 0
              ? -1
              : 1;
      const nextIndex = currentIndex + delta;

      cornerstone.utilities.jumpToSlice(element, {
        imageIndex: nextIndex,
        debounceLoading: false,
      });
      viewport.render?.();

      await new Promise(resolve => setTimeout(resolve, 700));

      return {
        viewportId: viewport.id,
        fromIndex: currentIndex,
        toIndex: viewport.getCurrentImageIdIndex?.(),
        requestedIndex: nextIndex,
        delta,
        totalSlices,
      };
    },
    { canvasIndex, preferredDelta }
  );
};

const getViewportToolState = async page => {
  return page.evaluate(() => {
    const cornerstone = (window as any).cornerstone;
    const cornerstoneTools = (window as any).cornerstoneTools;
    return (cornerstone?.getEnabledElements?.() ?? []).map((enabledElement, index) => {
      const viewport = enabledElement?.viewport;
      const element = enabledElement?.element || viewport?.element;
      const rect = element?.getBoundingClientRect?.();
      const toolGroup = cornerstoneTools?.ToolGroupManager?.getToolGroupForViewport?.(
        viewport?.id,
        viewport?.renderingEngineId
      );
      return {
        index,
        viewportId: viewport?.id,
        viewportType: viewport?.type,
        currentImageIdIndex: viewport?.getCurrentImageIdIndex?.(),
        currentImageId: viewport?.getCurrentImageId?.(),
        renderingEngineId: viewport?.renderingEngineId,
        toolGroupId: toolGroup?.id,
        activeTool: toolGroup?.getActivePrimaryMouseButtonTool?.(),
        hasCircularBrush: toolGroup?.hasTool?.('CircularBrush'),
        hasCircularEraser: toolGroup?.hasTool?.('CircularEraser'),
        representationCount: viewport?.id
          ? (window as any).services?.segmentationService?.getSegmentationRepresentations?.(
              viewport.id
            )?.length
          : 0,
        left: rect?.left,
        top: rect?.top,
        width: rect?.width,
        height: rect?.height,
      };
    });
  });
};

const getViewportSegmentColorState = async (page, segmentLabel: string) => {
  return page.evaluate(label => {
    const cornerstone = (window as any).cornerstone;
    const cornerstoneTools = (window as any).cornerstoneTools;
    const services = (window as any).services;
    const segmentationService = services?.segmentationService;
    const activeViewportId = services?.viewportGridService?.getState?.()?.activeViewportId;
    const segmentation = segmentationService
      ?.getSegmentations?.()
      ?.find(segmentation =>
        Object.values(segmentation.segments || {}).some((segment: any) => segment?.label === label)
      );
    const segment = Object.values(segmentation?.segments || {}).find(
      (segment: any) => segment?.label === label
    ) as any;
    const segmentIndex = segment?.segmentIndex;

    return (cornerstone?.getEnabledElements?.() ?? [])
      .map(enabledElement => {
        const viewport = enabledElement?.viewport;
        const element = enabledElement?.element || viewport?.element;
        const rect = element?.getBoundingClientRect?.();
        const color =
          segmentation?.segmentationId && segmentIndex !== undefined && viewport?.id
            ? segmentationService?.getSegmentColor?.(
                viewport.id,
                segmentation.segmentationId,
                segmentIndex
              )
            : null;
        return {
          viewportId: viewport?.id,
          segmentationId: segmentation?.segmentationId,
          segmentIndex,
          color,
          activeSegmentIndex: viewport?.id
            ? segmentationService?.getActiveSegment?.(viewport.id)?.segmentIndex
            : undefined,
          left: rect?.left,
          top: rect?.top,
          width: rect?.width,
          height: rect?.height,
          visible: Boolean(rect?.width && rect?.height),
        };
      })
      .filter(item => item.visible)
      .sort((a, b) => a.top - b.top || a.left - b.left);
  }, segmentLabel);
};

const getSegmentVoxelCountState = async (page, segmentLabel: string) => {
  return page.evaluate(label => {
    const cornerstone = (window as any).cornerstone;
    const cornerstoneTools = (window as any).cornerstoneTools;
    const services = (window as any).services;
    const segmentationService = services?.segmentationService;
    const activeViewportId = services?.viewportGridService?.getState?.()?.activeViewportId;
    const segmentation = segmentationService
      ?.getSegmentations?.()
      ?.find(segmentation =>
        Object.values(segmentation.segments || {}).some((segment: any) => segment?.label === label)
      );
    const segment = Object.values(segmentation?.segments || {}).find(
      (segment: any) => (segment as any)?.label === label
    ) as any;
    const labelmapData = segmentation?.representationData?.Labelmap;
    const volume = labelmapData?.volumeId
      ? cornerstone?.cache?.getVolume?.(labelmapData.volumeId)
      : null;
    let volumeScalarData = null;
    try {
      volumeScalarData = volume?.voxelManager?.getScalarData?.();
    } catch (error) {
      volumeScalarData = null;
    }
    let volumeCount = 0;
    if (volumeScalarData && segment?.segmentIndex !== undefined) {
      for (let i = 0; i < volumeScalarData.length; i++) {
        if (volumeScalarData[i] === segment.segmentIndex) {
          volumeCount += 1;
        }
      }
    }

    const imageCounts = (labelmapData?.imageIds || []).map((imageId, index) => {
      const image = cornerstone?.cache?.getImage?.(imageId);
      let scalarData = null;
      try {
        scalarData = image?.voxelManager?.getScalarData?.();
      } catch (error) {
        scalarData = null;
      }
      let count = 0;
      if (scalarData && segment?.segmentIndex !== undefined) {
        for (let i = 0; i < scalarData.length; i++) {
          if (scalarData[i] === segment.segmentIndex) {
            count += 1;
          }
        }
      }
      return { index, imageId, count };
    });

    return {
      segmentationId: segmentation?.segmentationId,
      segmentIndex: segment?.segmentIndex,
      activeViewportId,
      currentLabelmapImageId:
        activeViewportId && segmentation?.segmentationId
          ? cornerstoneTools?.segmentation?.state?.getCurrentLabelmapImageIdForViewport?.(
              activeViewportId,
              segmentation.segmentationId
            )
          : null,
      currentLabelmapImageIds:
        activeViewportId && segmentation?.segmentationId
          ? cornerstoneTools?.segmentation?.state?.getCurrentLabelmapImageIdsForViewport?.(
              activeViewportId,
              segmentation.segmentationId
            )
          : null,
      labelmapVolumeId: labelmapData?.volumeId,
      labelmapImageCount: labelmapData?.imageIds?.length || 0,
      volumeCount,
      imageCounts,
      brushDebug: (window as any).__oviBrushDebugInfo,
    };
  }, segmentLabel);
};

const getLabelmapActorState = async (page, canvasIndex: number, segmentLabel: string) => {
  return page.evaluate(
    ({ canvasIndex, label }) => {
      const cornerstone = (window as any).cornerstone;
      const cornerstoneTools = (window as any).cornerstoneTools;
      const services = (window as any).services;
      const segmentationService = services?.segmentationService;
      const enabledElement = (cornerstone?.getEnabledElements?.() ?? [])[canvasIndex];
      const viewport = enabledElement?.viewport;
      const segmentation = segmentationService
        ?.getSegmentations?.()
        ?.find(segmentation =>
          Object.values(segmentation.segments || {}).some(
            (segment: any) => segment?.label === label
          )
        );
      const segment = Object.values(segmentation?.segments || {}).find(
        (segment: any) => (segment as any)?.label === label
      ) as any;
      const actors = Object.values(viewport?.getActors?.() || {}).map((actorEntry: any) => {
        const actor = actorEntry?.actor;
        const mapper = actor?.getMapper?.();
        const imageData = mapper?.getInputData?.();
        const scalarData = imageData?.getPointData?.()?.getScalars?.()?.getData?.();
        const property = actor?.getProperty?.();
        const scalarOpacity = property?.getScalarOpacity?.(0);
        const rgbTransfer = property?.getRGBTransferFunction?.(0);
        let count = 0;
        if (scalarData && segment?.segmentIndex !== undefined) {
          for (let i = 0; i < scalarData.length; i++) {
            if (scalarData[i] === segment.segmentIndex) {
              count += 1;
            }
          }
        }
        return {
          uid: actorEntry?.uid,
          referencedId: actorEntry?.referencedId,
          visible: actor?.getVisibility?.(),
          scalarCount: count,
          bounds: actor?.getBounds?.(),
          imageOrigin: imageData?.getOrigin?.(),
          imageSpacing: imageData?.getSpacing?.(),
          imageDimensions: imageData?.getDimensions?.(),
          imageDirection: imageData?.getDirection?.(),
          actorMTime: actor?.getMTime?.(),
          mapperMTime: mapper?.getMTime?.(),
          imageMTime: imageData?.getMTime?.(),
          propertyMTime: property?.getMTime?.(),
          scalarOpacityMTime: scalarOpacity?.getMTime?.(),
          rgbTransferMTime: rgbTransfer?.getMTime?.(),
          scalarOpacityRange: scalarOpacity?.getRange?.(),
          rgbTransferRange: rgbTransfer?.getRange?.(),
        };
      });
      const currentImage = viewport?.getCurrentImageId
        ? cornerstone?.cache?.getImage?.(viewport.getCurrentImageId())
        : null;
      const currentImageMetadata =
        currentImage && viewport?.getImageDataMetadata
          ? viewport.getImageDataMetadata(currentImage)
          : null;
      const labelmapEntries =
        viewport?.id && segmentation?.segmentationId
          ? cornerstoneTools?.segmentation?.helpers?.getLabelmapActorEntries?.(
              viewport.id,
              segmentation.segmentationId
            )
          : null;

      return {
        viewportId: viewport?.id,
        currentImageIdIndex: viewport?.getCurrentImageIdIndex?.(),
        currentLabelmapImageId:
          viewport?.id && segmentation?.segmentationId
            ? cornerstoneTools?.segmentation?.state?.getCurrentLabelmapImageIdForViewport?.(
                viewport.id,
                segmentation.segmentationId
              )
            : null,
        segmentationId: segmentation?.segmentationId,
        segmentIndex: segment?.segmentIndex,
        currentImageId: viewport?.getCurrentImageId?.(),
        currentImageMetadata,
        actors,
        labelmapEntries: labelmapEntries?.map?.((entry: any) => ({
          uid: entry?.uid,
          referencedId: entry?.referencedId,
          visible: entry?.actor?.getVisibility?.(),
          bounds: entry?.actor?.getBounds?.(),
        })),
      };
    },
    { canvasIndex, label: segmentLabel }
  );
};

const expectBrushDrawsSelectedColorInEachCanvas = async ({
  page,
  studyUid,
  expectedCanvasCount,
}: {
  page: any;
  studyUid: string;
  expectedCanvasCount: number;
}) => {
  const writeGuard = await blockSegmentationWrites(page);

  await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${studyUid}`);
  await page.waitForLoadState('domcontentloaded');
  await waitForViewportCount(page, expectedCanvasCount);
  await waitForSegmentCards(page);

  const brushButton = page.locator('[data-cy="Brush"]').first();
  await expect(brushButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });

  const probeColor: [number, number, number, number] = [20, 184, 166, 255];
  const probeHex = rgbToHex(probeColor);

  const canvasOrder = await getVisibleCanvasOrder(page);
  expect(
    canvasOrder.length,
    `Expected ${expectedCanvasCount} visible canvases; order=${JSON.stringify(canvasOrder)}`
  ).toBeGreaterThanOrEqual(expectedCanvasCount);

  for (const canvasInfo of canvasOrder.slice(0, expectedCanvasCount)) {
    const canvas = page.locator('canvas.cornerstone-canvas').nth(canvasInfo.index);
    await canvas.click({ position: { x: canvasInfo.width / 2, y: canvasInfo.height / 2 } });

    const probeLabel = `Playwright Brush Probe ${expectedCanvasCount}-${canvasInfo.index}`;
    await addInMemorySegmentClass(page, {
      label: probeLabel,
      color: probeColor,
    });
    await page.waitForTimeout(500);
    await expectManualContourColor(page, probeHex);

    await brushButton.locator('button').click();
    await expect(brushButton).toHaveAttribute('data-active', 'true');

    await page.waitForFunction(
      () => {
        const services = (window as any).services;
        const activeViewportId = services?.viewportGridService?.getState?.()?.activeViewportId;
        const toolGroup =
          activeViewportId &&
          services?.toolGroupService?.getToolGroupForViewport?.(activeViewportId);
        return toolGroup?.getActivePrimaryMouseButtonTool?.() === 'CircularBrush';
      },
      { timeout: 5000 }
    );

    await page.waitForFunction(
      ({ label, color, canvasIndex }) => {
        const cornerstone = (window as any).cornerstone;
        const services = (window as any).services;
        const segmentationService = services?.segmentationService;
        const enabledElement = (cornerstone?.getEnabledElements?.() ?? [])[canvasIndex];
        const viewportId = enabledElement?.viewport?.id;
        const segmentation = segmentationService
          ?.getSegmentations?.()
          ?.find(segmentation =>
            Object.values(segmentation.segments || {}).some(
              (segment: any) => segment?.label === label
            )
          );
        const segment = Object.values(segmentation?.segments || {}).find(
          (segment: any) => (segment as any)?.label === label
        ) as any;
        const segmentColor =
          viewportId && segmentation?.segmentationId && segment?.segmentIndex !== undefined
            ? segmentationService?.getSegmentColor?.(
                viewportId,
                segmentation.segmentationId,
                segment.segmentIndex
              )
            : null;

        const activeSegmentIndex = viewportId
          ? segmentationService?.getActiveSegment?.(viewportId)?.segmentIndex
          : undefined;

        return (
          activeSegmentIndex === segment?.segmentIndex &&
          color.every((value, index) => segmentColor?.[index] === value)
        );
      },
      { label: probeLabel, color: probeColor, canvasIndex: canvasInfo.index },
      { timeout: 5000 }
    );

    const viewportSegmentColors = await getViewportSegmentColorState(page, probeLabel);
    const viewportToolState = await getViewportToolState(page);
    const activeCanvasColor = viewportSegmentColors.find(
      colorState => colorState.viewportId === viewportToolState[canvasInfo.index]?.viewportId
    );
    expect(
      activeCanvasColor?.color?.slice?.(0, 4),
      `Expected selected segment color in active canvas ${canvasInfo.index}; states=${JSON.stringify(
        viewportSegmentColors
      )}`
    ).toEqual(probeColor);
    expect(
      activeCanvasColor?.activeSegmentIndex,
      `Expected selected segment to be active in canvas ${canvasInfo.index}; states=${JSON.stringify(
        viewportSegmentColors
      )}`
    ).toBe(activeCanvasColor?.segmentIndex);

    const beforeDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
    const beforeVoxelCount = await getSegmentVoxelCountState(page, probeLabel);
    await drawBrushStrokeOnCanvas(page, canvasInfo.index);
    const afterDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
    const afterVoxelCount = await getSegmentVoxelCountState(page, probeLabel);

    expect(
      afterDraw.matchedPixels,
      `Expected Brush to add selected-color pixels in canvas ${canvasInfo.index}; before=${JSON.stringify(
        beforeDraw
      )} after=${JSON.stringify(afterDraw)} canvas=${JSON.stringify(
        canvasInfo
      )} voxelsBefore=${JSON.stringify(beforeVoxelCount)} voxelsAfter=${JSON.stringify(
        afterVoxelCount
      )} tools=${JSON.stringify(await getViewportToolState(page))}`
    ).toBeGreaterThan(beforeDraw.matchedPixels);
  }

  const blockedBeacons = await page.evaluate(
    () => (window as any).__blockedSegmentationBeacons || 0
  );
  expect(
    writeGuard.escaped,
    `Segmentation write requests must not hit the real backend. Blocked writes: ${JSON.stringify(
      writeGuard.blocked
    )}; blocked beacons: ${blockedBeacons}`
  ).toEqual([]);
};

const expectBrushPersistsAcrossSliceRoundTrip = async ({
  page,
  studyUid,
  expectedCanvasCount,
  targetCanvasOrdinal,
}: {
  page: any;
  studyUid: string;
  expectedCanvasCount: number;
  targetCanvasOrdinal?: number;
}) => {
  const writeGuard = await blockSegmentationWrites(page);

  await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${studyUid}`);
  await page.waitForLoadState('domcontentloaded');
  await waitForViewportCount(page, expectedCanvasCount);
  await waitForSegmentCards(page);

  const brushButton = page.locator('[data-cy="Brush"]').first();
  await expect(brushButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });

  const probeColor: [number, number, number, number] = [20, 184, 166, 255];
  const probeHex = rgbToHex(probeColor);
  const canvasOrder = await getVisibleCanvasOrder(page);
  expect(
    canvasOrder.length,
    `Expected ${expectedCanvasCount} visible canvases; order=${JSON.stringify(canvasOrder)}`
  ).toBeGreaterThanOrEqual(expectedCanvasCount);

  const targetCanvasInfos =
    targetCanvasOrdinal === undefined
      ? canvasOrder.slice(0, expectedCanvasCount)
      : [canvasOrder[targetCanvasOrdinal]];

  expect(
    targetCanvasInfos.every(Boolean),
    `Expected target canvas ordinal ${targetCanvasOrdinal} in order=${JSON.stringify(canvasOrder)}`
  ).toBe(true);

  for (const canvasInfo of targetCanvasInfos) {
    const canvas = page.locator('canvas.cornerstone-canvas').nth(canvasInfo.index);
    await canvas.click({ position: { x: canvasInfo.width / 2, y: canvasInfo.height / 2 } });

    const probeLabel = `Playwright Slice Probe ${expectedCanvasCount}-${canvasInfo.index}`;
    await addInMemorySegmentClass(page, {
      label: probeLabel,
      color: probeColor,
    });
    await page.waitForTimeout(500);
    await expectManualContourColor(page, probeHex);

    await brushButton.locator('button').click();
    await expect(brushButton).toHaveAttribute('data-active', 'true');

    const beforeFirstDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
    await drawBrushStrokeOnCanvas(page, canvasInfo.index);
    const afterFirstDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
    const afterFirstDrawActors = await getLabelmapActorState(page, canvasInfo.index, probeLabel);
    expect(
      afterFirstDraw.matchedPixels,
      `Expected initial slice brush draw before slice navigation; before=${JSON.stringify(
        beforeFirstDraw
      )} after=${JSON.stringify(afterFirstDraw)} canvas=${JSON.stringify(
        canvasInfo
      )} voxels=${JSON.stringify(
        await getSegmentVoxelCountState(page, probeLabel)
      )} actors=${JSON.stringify(afterFirstDrawActors)}`
    ).toBeGreaterThan(beforeFirstDraw.matchedPixels);

    const forwardStep = await stepCanvasSlice(page, canvasInfo.index, 1);
    expect(
      forwardStep.toIndex,
      `Expected canvas ${canvasInfo.index} to step to the adjacent slice; step=${JSON.stringify(
        forwardStep
      )} tools=${JSON.stringify(await getViewportToolState(page))}`
    ).toBe(forwardStep.requestedIndex);

    await brushButton.locator('button').click();
    await expect(brushButton).toHaveAttribute('data-active', 'true');
    const beforeNextDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
    await drawBrushStrokeOnCanvas(page, canvasInfo.index);
    const afterNextDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
    expect(
      afterNextDraw.matchedPixels,
      `Expected Brush to work after stepping to next slice in canvas ${
        canvasInfo.index
      }; before=${JSON.stringify(beforeNextDraw)} after=${JSON.stringify(
        afterNextDraw
      )} step=${JSON.stringify(forwardStep)} voxels=${JSON.stringify(
        await getSegmentVoxelCountState(page, probeLabel)
      )} actors=${JSON.stringify(
        await getLabelmapActorState(page, canvasInfo.index, probeLabel)
      )} tools=${JSON.stringify(await getViewportToolState(page))}`
    ).toBeGreaterThan(beforeNextDraw.matchedPixels);

    const backStep = await stepCanvasSlice(
      page,
      canvasInfo.index,
      forwardStep.delta === 1 ? -1 : 1
    );
    expect(
      backStep.toIndex,
      `Expected canvas ${canvasInfo.index} to return to the original slice; forward=${JSON.stringify(
        forwardStep
      )} back=${JSON.stringify(backStep)}`
    ).toBe(forwardStep.fromIndex);

    const afterReturn = await getCanvasColorStats(page, canvasInfo.index, probeColor);
    expect(
      afterReturn.matchedPixels,
      `Expected first-slice segmentation pixels to persist after stepping away and back in canvas ${
        canvasInfo.index
      }; first=${JSON.stringify(afterFirstDraw)} returned=${JSON.stringify(
        afterReturn
      )} forward=${JSON.stringify(forwardStep)} back=${JSON.stringify(
        backStep
      )} voxels=${JSON.stringify(
        await getSegmentVoxelCountState(page, probeLabel)
      )} firstActors=${JSON.stringify(
        afterFirstDrawActors
      )} actors=${JSON.stringify(await getLabelmapActorState(page, canvasInfo.index, probeLabel))}`
    ).toBeGreaterThan(0);

    await brushButton.locator('button').click();
    await expect(brushButton).toHaveAttribute('data-active', 'true');
    await drawBrushStrokeOnCanvas(page, canvasInfo.index);
    const afterReturnDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
    expect(
      afterReturnDraw.matchedPixels,
      `Expected Brush to still draw after returning to the original slice in canvas ${
        canvasInfo.index
      }; returned=${JSON.stringify(afterReturn)} afterReturnDraw=${JSON.stringify(
        afterReturnDraw
      )} tools=${JSON.stringify(await getViewportToolState(page))}`
    ).toBeGreaterThan(afterReturn.matchedPixels);
  }

  const blockedBeacons = await page.evaluate(
    () => (window as any).__blockedSegmentationBeacons || 0
  );
  expect(
    writeGuard.escaped,
    `Segmentation write requests must not hit the real backend. Blocked writes: ${JSON.stringify(
      writeGuard.blocked
    )}; blocked beacons: ${blockedBeacons}`
  ).toEqual([]);
};

// ---------------------------------------------------------------------------
// Per-viewport test helpers
// ---------------------------------------------------------------------------

interface ViewportTestParams {
  page: any;
  studyUid: string;
  expectedCanvasCount: number;
  canvasOrdinal: number;
}

const navigateAndWait = async (page, studyUid: string, expectedCanvasCount: number) => {
  await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${studyUid}`);
  await page.waitForLoadState('domcontentloaded');
  await waitForViewportCount(page, expectedCanvasCount);
  await waitForSegmentCards(page);
  const canvasOrder = await getVisibleCanvasOrder(page);
  expect(
    canvasOrder.length,
    `Expected ${expectedCanvasCount} visible canvases; got ${canvasOrder.length}`
  ).toBeGreaterThanOrEqual(expectedCanvasCount);
  return canvasOrder;
};

const focusCanvas = async (page, canvasInfo: { index: number; width: number; height: number }) => {
  await page.locator('canvas.cornerstone-canvas').nth(canvasInfo.index).click({
    position: { x: canvasInfo.width / 2, y: canvasInfo.height / 2 },
  });
  await page.waitForTimeout(300);
};

const selectSegmentByLabel = async (page, label: string) => {
  await page.waitForFunction(
    (lbl: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>('div.flex.overflow-hidden.rounded-md.border[style]')
      ).some(el => el.textContent?.includes(lbl)),
    label,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
  const cards = await page.locator('div.flex.overflow-hidden.rounded-md.border[style]').all();
  for (const card of cards) {
    const text = await card.textContent();
    if (text?.includes(label)) {
      await card.click();
      await page.waitForTimeout(200);
      return;
    }
  }
  throw new Error(`Segment card not found for label: ${label}`);
};

/**
 * T1 – All 4 tool buttons activate exclusively in the target viewport.
 */
const expectToolToggleInCanvas = async ({
  page,
  studyUid,
  expectedCanvasCount,
  canvasOrdinal,
}: ViewportTestParams) => {
  await blockSegmentationWrites(page);
  const canvasOrder = await navigateAndWait(page, studyUid, expectedCanvasCount);
  await focusCanvas(page, canvasOrder[canvasOrdinal]);

  const manualContourButton = page.locator('[data-cy="ManualContour"]').first();
  const contourEraserButton = page.locator('[data-cy="ManualContourEraser"]').first();
  const brushButton = page.locator('[data-cy="Brush"]').first();
  const eraserButton = page.locator('[data-cy="Eraser"]').first();
  await expect(manualContourButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });

  await contourEraserButton.locator('button').click();
  await expect(contourEraserButton).toHaveAttribute('data-active', 'true');
  await expect(manualContourButton).toHaveAttribute('data-active', 'false');

  await manualContourButton.locator('button').click();
  await expect(manualContourButton).toHaveAttribute('data-active', 'true');
  await expect(contourEraserButton).toHaveAttribute('data-active', 'false');

  await brushButton.locator('button').click();
  await expect(brushButton).toHaveAttribute('data-active', 'true');
  await expect(manualContourButton).toHaveAttribute('data-active', 'false');
  await expect(contourEraserButton).toHaveAttribute('data-active', 'false');

  await eraserButton.locator('button').click();
  await expect(eraserButton).toHaveAttribute('data-active', 'true');
  await expect(brushButton).toHaveAttribute('data-active', 'false');

  await manualContourButton.locator('button').click();
  await expect(manualContourButton).toHaveAttribute('data-active', 'true');
  await expect(eraserButton).toHaveAttribute('data-active', 'false');
};

/**
 * T2+T3+T4 – Contour draw adds pixels with the correct segment color (T2+T3),
 * and ManualContourEraser removes them (T4).
 */
const expectContourWorkflowInCanvas = async ({
  page,
  studyUid,
  expectedCanvasCount,
  canvasOrdinal,
}: ViewportTestParams) => {
  const writeGuard = await blockSegmentationWrites(page);
  const canvasOrder = await navigateAndWait(page, studyUid, expectedCanvasCount);
  const canvasInfo = canvasOrder[canvasOrdinal];
  await focusCanvas(page, canvasInfo);

  const manualContourButton = page.locator('[data-cy="ManualContour"]').first();
  const contourEraserButton = page.locator('[data-cy="ManualContourEraser"]').first();
  await expect(manualContourButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });

  await manualContourButton.locator('button').click();
  await expect(manualContourButton).toHaveAttribute('data-active', 'true');

  // Add a probe segment with a known distinctive teal color
  const probeColor: [number, number, number, number] = [20, 184, 166, 255];
  const probeHex = rgbToHex(probeColor);
  await addInMemorySegmentClass(page, { label: 'Contour Probe', color: probeColor });
  await page.waitForTimeout(300);

  const segmentCards = await getVisibleSegmentCardColors(page);
  const probeCardIndex = segmentCards.findIndex(card => /Contour Probe/i.test(card.text));
  expect(
    probeCardIndex,
    `Expected Contour Probe card; cards=${JSON.stringify(segmentCards)}`
  ).toBeGreaterThan(-1);

  // T3: color follows card selection — assert only after explicit switch to probe
  await page.locator('div.flex.overflow-hidden.rounded-md.border[style]').nth(probeCardIndex).click();
  await expectManualContourColor(page, probeHex);

  // T2: draw adds pixels with matching color
  const beforeDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
  const drawResult = await dispatchContourTrajectory(page, 'draw', 0.055, canvasInfo.index);
  expect(drawResult.result, `Expected contour draw; ${JSON.stringify(drawResult)}`).toBeTruthy();
  await page.waitForTimeout(500);
  const afterDraw = await getCanvasColorStats(page, canvasInfo.index, probeColor);
  expect(
    afterDraw.matchedPixels,
    `Expected contour draw to add pixels; before=${JSON.stringify(beforeDraw)} after=${JSON.stringify(afterDraw)}`
  ).toBeGreaterThan(beforeDraw.matchedPixels);

  // T4: contour erase removes pixels
  await contourEraserButton.locator('button').click();
  await expect(contourEraserButton).toHaveAttribute('data-active', 'true');
  const eraseResult = await dispatchContourTrajectory(page, 'erase', 0.03, canvasInfo.index);
  expect(eraseResult.result, `Expected contour erase; ${JSON.stringify(eraseResult)}`).toBeTruthy();
  await page.waitForTimeout(500);
  const afterErase = await getCanvasColorStats(page, canvasInfo.index, probeColor);
  expect(
    afterErase.matchedPixels,
    `Expected erase to reduce pixels; draw=${JSON.stringify(afterDraw)} erase=${JSON.stringify(afterErase)}`
  ).toBeLessThan(afterDraw.matchedPixels);

  const blockedBeacons = await page.evaluate(
    () => (window as any).__blockedSegmentationBeacons || 0
  );
  expect(
    writeGuard.escaped,
    `Unexpected backend writes; blocked=${JSON.stringify(writeGuard.blocked)}; beacons=${blockedBeacons}`
  ).toEqual([]);
};

/**
 * T7 – All 4 tools paint on slice A and B independently.
 * Slice A: Brush + ManualContour. Slice B: Brush + ManualContour.
 * Returns to A, verifies both A datasets intact.
 * Erases A (CircularEraser + ManualContourEraser), verifies slice B unaffected.
 */
const expectMultiToolSliceIsolation = async ({
  page,
  studyUid,
  expectedCanvasCount,
  canvasOrdinal,
}: ViewportTestParams) => {
  const writeGuard = await blockSegmentationWrites(page);
  const canvasOrder = await navigateAndWait(page, studyUid, expectedCanvasCount);
  const canvasInfo = canvasOrder[canvasOrdinal];
  await focusCanvas(page, canvasInfo);

  const brushButton = page.locator('[data-cy="Brush"]').first();
  const manualContourButton = page.locator('[data-cy="ManualContour"]').first();
  const contourEraserButton = page.locator('[data-cy="ManualContourEraser"]').first();
  const brushEraserButton = page.locator('[data-cy="Eraser"]').first();
  await expect(brushButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });

  const pfx = `Iso-${canvasOrdinal}`;
  const brushAColor: [number, number, number, number] = [239, 68, 68, 255];
  const contourAColor: [number, number, number, number] = [20, 184, 166, 255];
  const brushBColor: [number, number, number, number] = [168, 85, 247, 255];
  const contourBColor: [number, number, number, number] = [234, 179, 8, 255];

  await addInMemorySegmentClass(page, { label: `${pfx}-brushA`, color: brushAColor });
  await page.waitForTimeout(150);
  await addInMemorySegmentClass(page, { label: `${pfx}-contourA`, color: contourAColor });
  await page.waitForTimeout(150);
  await addInMemorySegmentClass(page, { label: `${pfx}-brushB`, color: brushBColor });
  await page.waitForTimeout(150);
  await addInMemorySegmentClass(page, { label: `${pfx}-contourB`, color: contourBColor });
  await page.waitForTimeout(300);

  // --- Slice A: Brush paint ---
  await selectSegmentByLabel(page, `${pfx}-brushA`);
  await brushButton.locator('button').click();
  await expect(brushButton).toHaveAttribute('data-active', 'true');
  await drawBrushStrokeOnCanvas(page, canvasInfo.index);
  const sliceABrush = await getCanvasColorStats(page, canvasInfo.index, brushAColor);
  expect(sliceABrush.matchedPixels, 'brushA on slice A').toBeGreaterThan(0);

  // --- Slice A: ManualContour paint ---
  await selectSegmentByLabel(page, `${pfx}-contourA`);
  await manualContourButton.locator('button').click();
  await expect(manualContourButton).toHaveAttribute('data-active', 'true');
  const contourADraw = await dispatchContourTrajectory(page, 'draw', 0.04, canvasInfo.index);
  expect(contourADraw.result, 'contourA draw on slice A').toBeTruthy();
  await page.waitForTimeout(500);
  const sliceAContour = await getCanvasColorStats(page, canvasInfo.index, contourAColor);
  expect(sliceAContour.matchedPixels, 'contourA on slice A').toBeGreaterThan(0);

  // --- Navigate to slice B ---
  const forwardStep = await stepCanvasSlice(page, canvasInfo.index, 1);
  expect(
    forwardStep.toIndex,
    `Expected step to slice B; step=${JSON.stringify(forwardStep)}`
  ).toBe(forwardStep.requestedIndex);

  // --- Slice B: Brush paint ---
  await selectSegmentByLabel(page, `${pfx}-brushB`);
  await brushButton.locator('button').click();
  await expect(brushButton).toHaveAttribute('data-active', 'true');
  await drawBrushStrokeOnCanvas(page, canvasInfo.index);
  const sliceBBrush = await getCanvasColorStats(page, canvasInfo.index, brushBColor);
  expect(sliceBBrush.matchedPixels, 'brushB on slice B').toBeGreaterThan(0);

  // --- Slice B: ManualContour paint ---
  await selectSegmentByLabel(page, `${pfx}-contourB`);
  await manualContourButton.locator('button').click();
  await expect(manualContourButton).toHaveAttribute('data-active', 'true');
  const contourBDraw = await dispatchContourTrajectory(page, 'draw', 0.04, canvasInfo.index);
  expect(contourBDraw.result, 'contourB draw on slice B').toBeTruthy();
  await page.waitForTimeout(500);
  const sliceBContour = await getCanvasColorStats(page, canvasInfo.index, contourBColor);
  expect(sliceBContour.matchedPixels, 'contourB on slice B').toBeGreaterThan(0);

  // --- Return to slice A: verify both A datasets intact ---
  const backStep = await stepCanvasSlice(page, canvasInfo.index, -1);
  expect(
    backStep.toIndex,
    `Expected return to slice A; forward=${JSON.stringify(forwardStep)} back=${JSON.stringify(backStep)}`
  ).toBe(forwardStep.fromIndex);

  const sliceABrushRestored = await getCanvasColorStats(page, canvasInfo.index, brushAColor);
  expect(
    sliceABrushRestored.matchedPixels,
    `brushA pixels persist on slice A; forward=${JSON.stringify(forwardStep)} back=${JSON.stringify(backStep)}`
  ).toBeGreaterThan(0);

  const sliceAContourRestored = await getCanvasColorStats(page, canvasInfo.index, contourAColor);
  expect(
    sliceAContourRestored.matchedPixels,
    'contourA pixels persist on slice A'
  ).toBeGreaterThan(0);

  // --- Slice A: CircularEraser reduces brushA pixels ---
  await selectSegmentByLabel(page, `${pfx}-brushA`);
  await brushEraserButton.locator('button').click();
  await expect(brushEraserButton).toHaveAttribute('data-active', 'true');
  await drawBrushStrokeOnCanvas(page, canvasInfo.index);
  const sliceABrushErased = await getCanvasColorStats(page, canvasInfo.index, brushAColor);
  expect(
    sliceABrushErased.matchedPixels,
    `CircularEraser should reduce brushA pixels; before=${sliceABrushRestored.matchedPixels} after=${sliceABrushErased.matchedPixels}`
  ).toBeLessThan(sliceABrushRestored.matchedPixels);

  // --- Slice A: ManualContourEraser reduces contourA pixels ---
  await contourEraserButton.locator('button').click();
  await expect(contourEraserButton).toHaveAttribute('data-active', 'true');
  const contourAErase = await dispatchContourTrajectory(page, 'erase', 0.03, canvasInfo.index);
  expect(contourAErase.result, 'contourA erase on slice A').toBeTruthy();
  await page.waitForTimeout(500);
  const sliceAContourErased = await getCanvasColorStats(page, canvasInfo.index, contourAColor);
  expect(
    sliceAContourErased.matchedPixels,
    `ManualContourEraser should reduce contourA pixels; before=${sliceAContourRestored.matchedPixels} after=${sliceAContourErased.matchedPixels}`
  ).toBeLessThan(sliceAContourRestored.matchedPixels);

  // --- Navigate to slice B: verify B data unaffected by slice A erases ---
  await stepCanvasSlice(page, canvasInfo.index, 1);
  const sliceBBrushFinal = await getCanvasColorStats(page, canvasInfo.index, brushBColor);
  expect(
    sliceBBrushFinal.matchedPixels,
    'brushB on slice B unaffected by slice A erases'
  ).toBeGreaterThan(0);
  const sliceBContourFinal = await getCanvasColorStats(page, canvasInfo.index, contourBColor);
  expect(
    sliceBContourFinal.matchedPixels,
    'contourB on slice B unaffected by slice A erases'
  ).toBeGreaterThan(0);

  const blockedBeacons = await page.evaluate(
    () => (window as any).__blockedSegmentationBeacons || 0
  );
  expect(
    writeGuard.escaped,
    `Unexpected backend writes; blocked=${JSON.stringify(writeGuard.blocked)}; beacons=${blockedBeacons}`
  ).toEqual([]);
};

// ---------------------------------------------------------------------------
// Test suite – matrix loop
// ---------------------------------------------------------------------------

test.describe('MedEx contour segmentation workflow', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  for (const study of STUDY_VIEWPORT_MATRIX) {
    for (const canvasOrdinal of study.viewportOrdinals) {
      const vpLabel = `${study.name} vp${canvasOrdinal + 1}`;
      const studyParams = {
        studyUid: study.studyUid,
        expectedCanvasCount: study.expectedCanvasCount,
        canvasOrdinal,
      };

      test(`${vpLabel} – tool buttons activate exclusively`, async ({ page }) => {
        await expectToolToggleInCanvas({ page, ...studyParams });
      });

      test(`${vpLabel} – contour draw+color+erase workflow`, async ({ page }) => {
        await expectContourWorkflowInCanvas({ page, ...studyParams });
      });

      test(`${vpLabel} – brush draws and persists across slice round-trip`, async ({ page }) => {
        await expectBrushPersistsAcrossSliceRoundTrip({
          page,
          studyUid: study.studyUid,
          expectedCanvasCount: study.expectedCanvasCount,
          targetCanvasOrdinal: canvasOrdinal,
        });
      });

      test(`${vpLabel} – all 4 tools paint correct layers across slices`, async ({ page }) => {
        await expectMultiToolSliceIsolation({ page, ...studyParams });
      });
    }
  }
});
