import authService, {
  hasSessionExpiredNotice,
} from '../../../../platform/app/src/services/authService';

const normalizeAuthBase = (value?: string): string => {
  if (!value) {
    return '/api';
  }

  return value.replace(/\/auth\/?$/, '');
};

const DEFAULT_AUTH_API_BASE = normalizeAuthBase(
  (typeof process !== 'undefined' && process.env?.REACT_APP_AUTH_API_URL) ||
    ((authService as any)?.baseUrl as string | undefined) ||
    '/api/auth'
);

const isAuthEnabled = (): boolean => process.env.REACT_APP_ENABLE_AUTH !== 'false';

const getCandidateBases = (baseUrl: string): string[] => {
  const bases = new Set<string>();
  const normalized = normalizeAuthBase(baseUrl);

  if (normalized.startsWith('/')) {
    if (
      typeof window !== 'undefined' &&
      ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ) {
      bases.add(`${window.location.protocol}//${window.location.hostname}:5000/api`);
    }

    bases.add(normalized);
  } else {
    bases.add(normalized);
  }

  return Array.from(bases);
};

const toBase64 = (data: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    result[i] = binary.charCodeAt(i);
  }
  return result;
};

const getStoredTokenFallback = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem('auth_token');
  } catch (error) {
    console.debug('[segmentation-api] failed to read auth token from localStorage', { error });
    return null;
  }
};

const getAuthHeaders = async (): Promise<Record<string, string> | null> => {
  const token =
    (typeof authService.ensureValidToken === 'function'
      ? await authService.ensureValidToken()
      : authService.getToken()) ||
    authService.getToken() ||
    getStoredTokenFallback();

  if (!token) {
    if (!isAuthEnabled()) {
      console.debug(
        '[segmentation-api] auth disabled; skipping authenticated segmentation persistence request'
      );
      return null;
    }

    if (hasSessionExpiredNotice()) {
      throw new Error(
        'Session expired. Refresh the page and log in again to access saved segmentations.'
      );
    }

    throw new Error('Cannot persist segmentation without an authenticated user.');
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
};

export interface SegmentationFrameRecord {
  id?: number;
  study_uid: string;
  series_uid: string;
  frame_number: number;
  frame_key: string;
  model_type: string;
  width: number;
  height: number;
  data_encoding?: 'base64';
  mask_data: Uint8Array;
  label_map?: Record<number, { labelId: string; labelName: string; labelColor: string }> | null;
  segmentation_label?: string;
}

class AnnotationApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = DEFAULT_AUTH_API_BASE) {
    this.baseUrl = baseUrl;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const bases = getCandidateBases(this.baseUrl);
    let lastError: unknown = null;
    let lastResponse: Response | null = null;

    for (const base of bases) {
      try {
        console.debug('[segmentation-api] request', {
          method: init.method || 'GET',
          url: `${base}${path}`,
        });
        const response = await fetch(`${base}${path}`, init);

        console.debug('[segmentation-api] response', {
          method: init.method || 'GET',
          url: `${base}${path}`,
          status: response.status,
          ok: response.ok,
          contentType: response.headers.get('content-type'),
        });

        if (response.ok) {
          return response;
        }

        const contentType = response.headers.get('content-type') || '';
        const isHtml404 =
          response.status === 404 &&
          (contentType.includes('text/html') || contentType.includes('text/plain'));

        if (isHtml404) {
          lastResponse = response;
          continue;
        }

        return response;
      } catch (error) {
        console.debug('[segmentation-api] request failed', {
          method: init.method || 'GET',
          url: `${base}${path}`,
          error,
        });
        lastError = error;
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to fetch');
  }

  async listSegmentationFrames({
    studyUID,
    seriesUID,
    modelType,
  }: {
    studyUID: string;
    seriesUID: string;
    modelType?: string;
  }): Promise<SegmentationFrameRecord[]> {
    const headers = await getAuthHeaders();
    if (!headers) {
      return [];
    }

    const search = new URLSearchParams({
      study: studyUID,
      series: seriesUID,
    });

    if (modelType) {
      search.set('model', modelType);
    }

    const response = await this.request(`/segmentation-frames?${search.toString()}`, {
      headers,
      credentials: 'include',
    });

    if (response.status === 400) {
      console.debug('[segmentation-api] bulk segmentation frame delete not supported by backend yet', {
        studyUID,
        seriesUID,
        modelType,
      });
      return;
    }

    if (!response.ok) {
      throw new Error(`Failed to load segmentation frames: ${response.statusText}`);
    }

    const records = await response.json();
    console.debug('[segmentation-api] loaded segmentation frames', {
      studyUID,
      seriesUID,
      modelType: modelType || null,
      count: records.length,
    });
    return records.map(record => ({
      ...record,
      mask_data: fromBase64(record.mask_data),
    }));
  }

  async saveSegmentationFrame(frame: SegmentationFrameRecord): Promise<void> {
    const headers = await getAuthHeaders();
    if (!headers) {
      return;
    }

    const response = await this.request('/segmentation-frames', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        ...frame,
        data_encoding: 'base64',
        mask_data: toBase64(frame.mask_data),
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to save segmentation frame: ${response.statusText}`);
    }

    console.debug('[segmentation-api] saved segmentation frame', {
      studyUID: frame.study_uid,
      seriesUID: frame.series_uid,
      modelType: frame.model_type,
      frameKey: frame.frame_key,
      frameNumber: frame.frame_number,
      width: frame.width,
      height: frame.height,
    });
  }

  async deleteSegmentationFrame({
    studyUID,
    seriesUID,
    modelType,
    frameKey,
  }: {
    studyUID: string;
    seriesUID: string;
    modelType: string;
    frameKey: string;
  }): Promise<void> {
    const headers = await getAuthHeaders();
    if (!headers) {
      return;
    }

    const search = new URLSearchParams({
      study: studyUID,
      series: seriesUID,
      model: modelType,
      frame_key: frameKey,
    });

    const response = await this.request(`/segmentation-frames?${search.toString()}`, {
      method: 'DELETE',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to delete segmentation frame: ${response.status} ${response.statusText}${
          body ? ` - ${body}` : ''
        }`
      );
    }

    console.debug('[segmentation-api] deleted segmentation frame', {
      studyUID,
      seriesUID,
      modelType,
      frameKey,
    });
  }

  async deleteSegmentationFrames({
    studyUID,
    seriesUID,
    modelType,
  }: {
    studyUID: string;
    seriesUID: string;
    modelType: string;
  }): Promise<void> {
    const headers = await getAuthHeaders();
    if (!headers) {
      return;
    }

    const search = new URLSearchParams({
      study: studyUID,
      series: seriesUID,
      model: modelType,
    });

    const response = await this.request(`/segmentation-frames?${search.toString()}`, {
      method: 'DELETE',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to delete segmentation frames: ${response.status} ${response.statusText}${
          body ? ` - ${body}` : ''
        }`
      );
    }

    console.debug('[segmentation-api] deleted segmentation frames', {
      studyUID,
      seriesUID,
      modelType,
    });
  }
}

export const annotationApi = new AnnotationApiClient();
