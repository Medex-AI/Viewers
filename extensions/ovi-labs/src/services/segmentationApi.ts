/**
 * Segmentation API Client
 *
 * Provides methods to interact with the MedEx segmentation backend:
 * - List available models with their parameter schemas
 * - Submit segmentation jobs
 * - Poll job status and retrieve results
 *
 * Sprint 3.2: Create segmentation API client
 *
 * Backend URL Configuration:
 * - Default: http://localhost:8000
 * - Can be overridden via environment variable: REACT_APP_SEGMENTATION_API_URL
 * - TODO: Add to OVI Labs user preferences for per-user configuration
 */

// Backend API URL from environment or default
const DEFAULT_BACKEND_URL = process.env.REACT_APP_SEGMENTATION_API_URL || 'http://localhost:8000';

// Load backend URL from localStorage if available
const loadBackendUrl = (): string => {
  if (typeof window !== 'undefined' && window.localStorage) {
    const savedUrl = localStorage.getItem('ovi-labs-backend-url');
    if (savedUrl) {
      return savedUrl;
    }
  }
  return DEFAULT_BACKEND_URL;
};

// Global backend URL (can be changed via setBackendUrl)
let BACKEND_URL = loadBackendUrl();

export interface ModelInfo {
  model_id: string;
  name: string;
  model_type: string;
  requires_gpu: boolean;
  hardware_requirements?: {
    min_requirement: 'cpu' | 'cuda_gpu' | 'apple_mps' | 'tpu';
    supported_on: string[];
    optimal_on: string;
    allow_cpu_fallback: boolean;
  };
  can_run?: boolean; // Whether model can run on current hardware
  hardware_status?: string; // Message about hardware availability
  params_schema: {
    type: string;
    properties: Record<string, any>;
    additionalProperties?: boolean;
  };
}

export interface HardwareInfo {
  has_cuda_gpu: boolean;
  cuda_device_count: number;
  has_apple_silicon: boolean;
  has_apple_mps: boolean;
  has_tpu: boolean;
  platform: string;
  python_version: string;
}

export interface SegmentationJobRequest {
  model_id: string;
  image: number[][] | number[][][]; // 2D or 3D array
  prompt?: {
    type: 'mask' | 'bbox' | 'points';
    data: Record<string, any>;
  };
  params?: Record<string, any>; // Model-specific parameters
}

export interface SegmentationJobResponse {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  poll_url?: string;
}

export interface SegmentationResult {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  result?: {
    mask: number[][]; // Segmentation label mask
    labels: Array<{
      id: number;
      name: string;
      color: string;
    }>;
    metadata: Record<string, any>;
  };
  error?: string;
}

class SegmentationApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = BACKEND_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * List all available segmentation models with hardware capabilities
   */
  async listModels(): Promise<{ models: ModelInfo[]; hardware?: HardwareInfo }> {
    const response = await fetch(`${this.baseUrl}/api/v1/models`);

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Submit a segmentation job
   */
  async submitJob(request: SegmentationJobRequest): Promise<SegmentationJobResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/segment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(errorData.detail || `Failed to submit job: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get job status and result
   */
  async getJobResult(jobId: string): Promise<SegmentationResult> {
    const response = await fetch(`${this.baseUrl}/api/v1/jobs/${jobId}`);

    if (!response.ok) {
      throw new Error(`Failed to get job result: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Poll job until completion with exponential backoff
   *
   * @param jobId - Job ID to poll
   * @param maxWaitMs - Maximum time to wait in milliseconds (default: 300000 = 5 minutes)
   * @returns Final job result
   */
  async pollJob(jobId: string, maxWaitMs: number = 300000): Promise<SegmentationResult> {
    const waitTimes = [1000, 2000, 4000, 8000, 16000, 30000]; // milliseconds
    const startTime = Date.now();
    let waitIndex = 0;

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.getJobResult(jobId);

      if (result.status === 'completed' || result.status === 'failed') {
        return result;
      }

      // Exponential backoff
      const waitTime = waitTimes[Math.min(waitIndex, waitTimes.length - 1)];
      await new Promise(resolve => setTimeout(resolve, waitTime));
      waitIndex++;
    }

    throw new Error(`Job ${jobId} did not complete within ${maxWaitMs}ms`);
  }

  /**
   * Submit job and wait for result (convenience method)
   */
  async segmentAndWait(request: SegmentationJobRequest, maxWaitMs?: number): Promise<SegmentationResult> {
    const jobResponse = await this.submitJob(request);
    return this.pollJob(jobResponse.job_id, maxWaitMs);
  }

  /**
   * Check if backend is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Set the backend URL (for user preferences)
 *
 * @param url - Backend URL (e.g., 'http://localhost:8000' or 'https://api.example.com')
 *
 * TODO: Wire this to OVI Labs user preferences
 * When user preferences UI is implemented, call this function with the saved URL:
 *
 * Example integration:
 * ```typescript
 * // In user preferences panel:
 * const handleSavePreferences = (prefs) => {
 *   if (prefs.segmentationBackendUrl) {
 *     setSegmentationBackendUrl(prefs.segmentationBackendUrl);
 *   }
 * };
 * ```
 */
export function setSegmentationBackendUrl(url: string): void {
  BACKEND_URL = url;
  // Recreate singleton with new URL
  Object.assign(segmentationApi, new SegmentationApiClient(url));
}

/**
 * Get the current backend URL
 */
export function getSegmentationBackendUrl(): string {
  return BACKEND_URL;
}

/**
 * Reset backend URL to default
 */
export function resetSegmentationBackendUrl(): void {
  setSegmentationBackendUrl(DEFAULT_BACKEND_URL);
}

// Singleton instance
export const segmentationApi = new SegmentationApiClient(BACKEND_URL);

export default segmentationApi;
