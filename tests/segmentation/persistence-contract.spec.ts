import { test, expect } from 'playwright-test-coverage';

const SINGLE_VIEWPORT_STUDY_UID = '2.25.886183689675766305740169196162815250747';

const makeJwt = () => {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      user_id: 1,
      username: 'contract-user',
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    })
  );
  return `${header}.${payload}.contract-test-signature`;
};

test.describe('Segmentation persistence contract', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(token => {
      window.localStorage.setItem('auth_token', token as string);
      window.localStorage.setItem(
        'auth_user',
        JSON.stringify({ id: '1', username: 'contract-user', email: 'contract@example.com' })
      );
    }, makeJwt());

    await page.route('**/api/auth/verify', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          authenticated: true,
          user: { id: 1, username: 'contract-user' },
        }),
      });
    });
  });

  const mockEmptyLegacyFrames = async (page: any) => {
    await page.route(/\/api\/segmentation-frames\?.*/, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { frames: [] } }),
      });
    });
  };

  test('renamed label restores from segmentation metadata document after reload', async ({ page }) => {
    let labelName = 'Initial Label';
    let revision = 1;
    const seenRequests: Array<{ method: string; url: string; body?: unknown }> = [];

    await mockEmptyLegacyFrames(page);

    await page.route(/\/api\/segmentations\?.*/, async route => {
      seenRequests.push({ method: route.request().method(), url: route.request().url() });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          resource: 'segmentation-list',
          status: 'synced',
          data: {
            segmentations: [
              {
                id: 'seg-contract-1',
                study_uid: SINGLE_VIEWPORT_STUDY_UID,
                series_uid: 'series-contract-1',
                display_set_instance_uid: 'display-set-contract-1',
                model_type: 'segmentation',
                label: 'Contract Labelmap',
                revision,
                labels: {
                  '1': { name: labelName, color: '#ff0000', locked: false },
                },
              },
            ],
          },
        }),
      });
    });

    await page.route('**/api/segmentations/seg-contract-1', async route => {
      const request = route.request();
      const method = request.method();
      const body = method === 'PATCH' ? request.postDataJSON() : undefined;
      seenRequests.push({ method, url: request.url(), body });

      if (method === 'PATCH') {
        labelName = body?.labels?.['1']?.name ?? labelName;
        revision += 1;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          resource: 'segmentation',
          id: 'seg-contract-1',
          revision,
          status: 'synced',
          data: {
            segmentation: {
              id: 'seg-contract-1',
              label: 'Contract Labelmap',
              revision,
              labels: {
                '1': { name: labelName, color: '#ff0000', locked: false },
              },
            },
          },
        }),
      });
    });

    await page.route('**/api/segmentations/seg-contract-1/frames**', async route => {
      seenRequests.push({ method: route.request().method(), url: route.request().url() });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          resource: 'segmentation-frames',
          id: 'seg-contract-1',
          revision,
          status: 'synced',
          data: { frames: [] },
        }),
      });
    });

    await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('[data-cy="data-row"]')).toContainText('Initial Label', {
      timeout: 60_000,
    });

    const dataRow = page.locator('[data-cy="data-row"]').first();
    await dataRow.hover();
    await dataRow.locator('button[aria-label="Actions"]').click();
    await page.getByRole('menuitem', { name: /^Rename$/i }).click();
    await page.getByPlaceholder(/enter new label/i).fill('Renamed Label');
    await page.getByRole('button', { name: /save|ok|rename/i }).click();

    await expect.poll(() => seenRequests.some(req => req.method === 'PATCH')).toBe(true);
    await expect(page.locator('[data-cy="data-row"]')).toContainText('Renamed Label');

    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('[data-cy="data-row"]')).toContainText('Renamed Label', {
      timeout: 60_000,
    });
    await expect(page.locator('[data-cy="data-row"]')).not.toContainText('Initial Label');
  });

  test('renamed label creates metadata document when none exists before reload', async ({ page }) => {
    let created = false;
    let labelName = 'Segment 1';
    const seenRequests: Array<{ method: string; url: string; body?: unknown }> = [];

    await mockEmptyLegacyFrames(page);

    await page.route(/\/api\/segmentations\?.*/, async route => {
      seenRequests.push({ method: route.request().method(), url: route.request().url() });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          resource: 'segmentation-list',
          status: 'synced',
          data: {
            segmentations: created
              ? [
                  {
                    id: 'seg-contract-created-1',
                    study_uid: SINGLE_VIEWPORT_STUDY_UID,
                    series_uid: 'series-contract-created-1',
                    model_type: 'segmentation',
                    label: 'Segmentation 1',
                    revision: 1,
                    labels: {
                      '1': { name: labelName, color: '#ffffff', locked: false },
                    },
                  },
                ]
              : [],
          },
        }),
      });
    });

    await page.route('**/api/segmentations', async route => {
      const request = route.request();
      if (request.method() !== 'POST') {
        await route.fallback();
        return;
      }

      const body = request.postDataJSON();
      seenRequests.push({ method: request.method(), url: request.url(), body });
      created = true;
      labelName = body?.labels?.['1']?.name ?? labelName;

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          resource: 'segmentation',
          id: 'seg-contract-created-1',
          revision: 1,
          status: 'synced',
          data: {
            segmentation: {
              id: 'seg-contract-created-1',
              label: body?.label || 'Segmentation 1',
              revision: 1,
              labels: {
                '1': { name: labelName, color: '#ffffff', locked: false },
              },
            },
          },
        }),
      });
    });

    await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`);
    await expect(page.locator('[data-cy="data-row"]')).toContainText('Segment 1', {
      timeout: 60_000,
    });

    const dataRow = page.locator('[data-cy="data-row"]').first();
    await dataRow.hover();
    await dataRow.locator('button[aria-label="Actions"]').click();
    await page.getByRole('menuitem', { name: /^Rename$/i }).click();
    await page.getByPlaceholder(/enter new label/i).fill('Created Metadata Label');
    await page.getByRole('button', { name: /save|ok|rename/i }).click();

    await expect.poll(() => seenRequests.some(req => req.method === 'POST')).toBe(true);
    await expect(page.locator('[data-cy="data-row"]')).toContainText('Created Metadata Label');

    await page.reload();
    await expect(page.locator('[data-cy="data-row"]')).toContainText('Created Metadata Label', {
      timeout: 60_000,
    });
  });

  test('deleting a label sends metadata removal before reload can stay empty', async ({ page }) => {
    const seenPatches: unknown[] = [];

    await mockEmptyLegacyFrames(page);

    await page.route(/\/api\/segmentations\?.*/, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          resource: 'segmentation-list',
          status: 'synced',
          data: {
            segmentations: [
              {
                id: 'seg-delete-contract-1',
                study_uid: SINGLE_VIEWPORT_STUDY_UID,
                series_uid: 'series-contract-1',
                model_type: 'segmentation',
                label: 'Contract Labelmap',
                revision: 1,
                labels: { '1': { name: 'Delete Me', color: '#ff0000', locked: false } },
              },
            ],
          },
        }),
      });
    });

    await page.route('**/api/segmentations/seg-delete-contract-1', async route => {
      if (route.request().method() === 'PATCH') {
        seenPatches.push(route.request().postDataJSON());
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          resource: 'segmentation',
          id: 'seg-delete-contract-1',
          revision: 2,
          status: 'synced',
          data: {
            segmentation: {
              id: 'seg-delete-contract-1',
              label: 'Contract Labelmap',
              revision: 2,
              labels: {},
            },
          },
        }),
      });
    });

    await page.route('**/api/segmentations/seg-delete-contract-1/frames**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, status: 'synced', data: { frames: [] } }),
      });
    });

    await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`);
    await expect(page.locator('[data-cy="data-row"]')).toContainText('Delete Me', {
      timeout: 60_000,
    });

    const dataRow = page.locator('[data-cy="data-row"]').first();
    await dataRow.hover();
    await dataRow.locator('button[aria-label="Actions"]').click();
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();
    await page.getByRole('button', { name: /^Delete$/i }).click();

    await expect
      .poll(() => seenPatches.some(body => JSON.stringify(body).includes('remove_labels')))
      .toBe(true);
  });
});
