import { test } from 'playwright-test-coverage';
import { loginAs } from './utils';

const STUDY_UID = '2.25.923096752237823522504815513406976806917';

test('diagnostic: inspect window cornerstone globals and actor uids', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('seg-autoload') || text.includes('autoCreate') || text.includes('restoreFrames') || text.includes('segmentation-load-debug') || msg.type() === 'error') {
      logs.push(`[${msg.type()}] ${text}`);
    }
  });

  await loginAs(page);
  await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${STUDY_UID}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle');
  // Wait up to 45s for a segmentation actor to appear
  await page.waitForTimeout(45_000);

  const info = await page.evaluate(() => {
    const cs = (window as any).cornerstone;
    const csTools = (window as any).cornerstoneTools;
    let elements: any[] = [];
    let actors: any[] = [];
    try {
      elements = cs?.getEnabledElements?.() ?? [];
      actors = elements.flatMap((el: any) => {
        const viewportActors = el.viewport?.getActors?.() ?? [];
        return viewportActors.map((a: any) => ({
          uid: a.uid,
          actorKeys: Object.keys(a),
          viewportId: el.viewport?.id,
        }));
      });
    } catch (e: any) {
      actors = [{ error: (e as Error).message }];
    }

    // Also check cornerstoneTools segmentation state
    let segState: any = null;
    try {
      const allSegs = csTools?.segmentation?.state?.getAllSegmentations?.() ?? [];
      segState = allSegs.map((s: any) => ({
        segmentationId: s.segmentationId,
        label: s.label,
        representationData: Object.keys(s.representationData ?? {}),
      }));
    } catch (e: any) {
      segState = { error: (e as Error).message };
    }

    return {
      currentUrl: window.location.href,
      enabledElementCount: elements.length,
      actors,
      segState,
    };
  });

  console.log('[diagnostic]', JSON.stringify(info, null, 2));
  console.log('[diagnostic] console logs:', logs.join('\n') || '(none)');
});
