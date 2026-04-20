/**
 * Segmentation Parameters Store
 *
 * Stores model-specific parameters for backend segmentation models.
 * Parameters are configured via SegmentationConfigModal and used during recompute.
 */

// Model params: modelId -> params object
let modelParams: Record<string, Record<string, any>> = {};

type Subscriber = (params: Record<string, Record<string, any>>) => void;
const subscribers: Set<Subscriber> = new Set();

const notifySubscribers = (): void => {
  subscribers.forEach(subscriber => subscriber(modelParams));
};

export const getModelParams = (modelId: string): Record<string, any> => {
  return modelParams[modelId] || {};
};

export const setModelParams = (modelId: string, params: Record<string, any>): void => {
  modelParams = {
    ...modelParams,
    [modelId]: params,
  };
  notifySubscribers();
};

export const getAllModelParams = (): Record<string, Record<string, any>> => {
  return modelParams;
};

export const subscribeModelParams = (subscriber: Subscriber): (() => void) => {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
};

export const resetModelParams = (): void => {
  modelParams = {};
  notifySubscribers();
};
