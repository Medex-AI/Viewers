import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useResizeDetector } from 'react-resize-detector';
import * as cs3DTools from '@cornerstonejs/tools';
import { cache, Enums, eventTarget, getEnabledElement, utilities as csUtils } from '@cornerstonejs/core';
import { MeasurementService } from '@ohif/core';
import { AllInOneMenu } from '@ohif/ui-next';
import { useViewportDialog } from '@ohif/ui-next';

import { setEnabledElement } from '../state';

import './OHIFCornerstoneViewport.css';
import CornerstoneOverlays from './Overlays/CornerstoneOverlays';
import CinePlayer from '../components/CinePlayer';
import type { Types } from '@ohif/core';

import OHIFViewportActionCorners from '../components/OHIFViewportActionCorners';
import { getWindowLevelActionMenu } from '../components/WindowLevelActionMenu/getWindowLevelActionMenu';
import { getViewportDataOverlaySettingsMenu } from '../components/ViewportDataOverlaySettingMenu';
import { getViewportPresentations } from '../utils/presentations/getViewportPresentations';
import { useSynchronizersStore } from '../stores/useSynchronizersStore';
import ActiveViewportBehavior from '../utils/ActiveViewportBehavior';
import { WITH_NAVIGATION } from '../services/ViewportService/CornerstoneViewportService';

const STACK = 'stack';
const TABLET_SCROLL_STEP_PX = 24;
const TABLET_ZOOM_THRESHOLD_PX = 12;
const TABLET_SCROLL_LOCK_THRESHOLD_PX = 8;
const TABLET_SCROLL_MAX_HORIZONTAL_DRIFT_PX = 14;
const TABLET_SCROLL_MAX_VERTICAL_DELTA_MISMATCH_PX = 16;
const TABLET_ZOOM_LOCK_THRESHOLD_PX = 4;
const TABLET_PAN_LOCK_THRESHOLD_PX = 5;
const CONTOUR_LONG_PRESS_MS = 700;
const CONTOUR_LONG_PRESS_MOVE_CANCEL_PX = 10;
const isTouchCapableDevice = () =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

const getTouchDistance = (touches: Touch[]) => {
  if (touches.length < 2) {
    return 0;
  }

  const [a, b] = touches;
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
};

const getTouchArray = (touchList: TouchList) => Array.from(touchList);
const getTouchType = (touch?: Touch) =>
  (touch as Touch & { touchType?: string })?.touchType || 'unknown';
const touchListContainsStylus = (touches: TouchList | Touch[]) =>
  Array.from(touches || []).some(
    touch => (touch as Touch & { touchType?: string })?.touchType === 'stylus'
  );
const touchListContainsDirect = (touches: TouchList | Touch[]) =>
  Array.from(touches || []).some(
    touch => (touch as Touch & { touchType?: string })?.touchType === 'direct'
  );

const normalizeTouchPoint = (touch: Touch) => ({
  x: touch.clientX,
  y: touch.clientY,
});

const getTouchCenter = (touches: Array<{ x: number; y: number }>) => {
  if (!touches.length) {
    return { x: 0, y: 0 };
  }

  const total = touches.reduce(
    (acc, touch) => ({
      x: acc.x + touch.x,
      y: acc.y + touch.y,
    }),
    { x: 0, y: 0 }
  );

  return {
    x: total.x / touches.length,
    y: total.y / touches.length,
  };
};

// Todo: This should be done with expose of internal API similar to react-vtkjs-viewport
// Then we don't need to worry about the re-renders if the props change.
const OHIFCornerstoneViewport = React.memo(
  (
    props: withAppTypes<{
      viewportId: string;
      displaySets: AppTypes.DisplaySet[];
      viewportOptions: AppTypes.ViewportGrid.GridViewportOptions;
      initialImageIndex: number;
    }>
  ) => {
    const {
      displaySets,
      dataSource,
      viewportOptions,
      displaySetOptions,
      servicesManager,
      commandsManager,
      onElementEnabled,
      // eslint-disable-next-line react/prop-types
      onElementDisabled,
      isJumpToMeasurementDisabled = false,
      // Note: you SHOULD NOT use the initialImageIdOrIndex for manipulation
      // of the imageData in the OHIFCornerstoneViewport. This prop is used
      // to set the initial state of the viewport's first image to render
      // eslint-disable-next-line react/prop-types
      initialImageIndex,
      // if the viewport is part of a hanging protocol layout
      // we should not really rely on the old synchronizers and
      // you see below we only rehydrate the synchronizers if the viewport
      // is not part of the hanging protocol layout. HPs should
      // define their own synchronizers. Since the synchronizers are
      // viewportId dependent and
      // eslint-disable-next-line react/prop-types
      isHangingProtocolLayout,
    } = props;
    const viewportId = viewportOptions.viewportId;

    if (!viewportId) {
      throw new Error('Viewport ID is required');
    }

    // Make sure displaySetOptions has one object per displaySet
    while (displaySetOptions.length < displaySets.length) {
      displaySetOptions.push({});
    }

    // Since we only have support for dynamic data in volume viewports, we should
    // handle this case here and set the viewportType to volume if any of the
    // displaySets are dynamic volumes
    viewportOptions.viewportType = displaySets.some(
      ds => ds.isDynamicVolume && ds.isReconstructable
    )
      ? 'volume'
      : viewportOptions.viewportType;

    const [scrollbarHeight, setScrollbarHeight] = useState('100px');
    const [enabledVPElement, setEnabledVPElement] = useState(null);
    const [inputDebugInfo, setInputDebugInfo] = useState('');
    const [contourDebugInfo, setContourDebugInfo] = useState('');
    const [brushDebugInfo, setBrushDebugInfo] = useState('');
    const [brushSaveDebugInfo, setBrushSaveDebugInfo] = useState('');
    const elementRef = useRef() as React.MutableRefObject<HTMLDivElement>;
    const tabletGestureStateRef = useRef<{
      mode: null | 'zoom' | 'scroll' | 'pan';
      lastTouches?: Array<{ x: number; y: number }>;
      lastDistance?: number;
      scrollAccumulator: number;
    }>({
      mode: null,
      scrollAccumulator: 0,
    });
    const contourLongPressRef = useRef<{
      timeoutId?: number;
      startPoint?: { x: number; y: number };
      fired: boolean;
    }>({
      fired: false,
    });
    // Tracks whether an Apple Pencil (or other stylus) is currently in contact,
    // used to suppress palm touch events while drawing.
    const pencilActiveRef = useRef(false);

    const {
      displaySetService,
      toolbarService,
      toolGroupService,
      syncGroupService,
      cornerstoneViewportService,
      segmentationService,
      cornerstoneCacheService,
      viewportActionCornersService,
      customizationService,
      measurementService,
    } = servicesManager.services;

    const [viewportDialogState] = useViewportDialog();
    // useCallback for scroll bar height calculation
    const setImageScrollBarHeight = useCallback(() => {
      const scrollbarHeight = `${elementRef.current.clientHeight - 10}px`;
      setScrollbarHeight(scrollbarHeight);
    }, [elementRef]);

    // useCallback for onResize
    const onResize = useCallback(() => {
      if (elementRef.current) {
        cornerstoneViewportService.resize();
        setImageScrollBarHeight();
      }
    }, [elementRef]);

    const cleanUpServices = useCallback(
      viewportInfo => {
        const renderingEngineId = viewportInfo.getRenderingEngineId();
        const syncGroups = viewportInfo.getSyncGroups();

        toolGroupService.removeViewportFromToolGroup(viewportId, renderingEngineId);
        syncGroupService.removeViewportFromSyncGroup(viewportId, renderingEngineId, syncGroups);

        segmentationService.clearSegmentationRepresentations(viewportId);

        viewportActionCornersService.clear(viewportId);
      },
      [
        viewportId,
        segmentationService,
        syncGroupService,
        toolGroupService,
        viewportActionCornersService,
      ]
    );

    const elementEnabledHandler = useCallback(
      evt => {
        // check this is this element reference and return early if doesn't match
        if (evt.detail.element !== elementRef.current) {
          return;
        }

        const { viewportId, element } = evt.detail;
        const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

        if (!viewportInfo) {
          return;
        }

        setEnabledElement(viewportId, element);
        setEnabledVPElement(element);

        const renderingEngineId = viewportInfo.getRenderingEngineId();
        const toolGroupId = viewportInfo.getToolGroupId();
        const syncGroups = viewportInfo.getSyncGroups();

        toolGroupService.addViewportToToolGroup(viewportId, renderingEngineId, toolGroupId);

        syncGroupService.addViewportToSyncGroup(viewportId, renderingEngineId, syncGroups);

        // we don't need reactivity here so just use state
        const { synchronizersStore } = useSynchronizersStore.getState();
        if (synchronizersStore?.[viewportId]?.length && !isHangingProtocolLayout) {
          // If the viewport used to have a synchronizer, re apply it again
          _rehydrateSynchronizers(viewportId, syncGroupService);
        }

        if (onElementEnabled && typeof onElementEnabled === 'function') {
          onElementEnabled(evt);
        }
      },
      [viewportId, onElementEnabled, toolGroupService]
    );

    // disable the element upon unmounting
    useEffect(() => {
      cornerstoneViewportService.enableViewport(viewportId, elementRef.current);

      eventTarget.addEventListener(Enums.Events.ELEMENT_ENABLED, elementEnabledHandler);

      setImageScrollBarHeight();

      return () => {
        const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

        if (!viewportInfo) {
          return;
        }

        cornerstoneViewportService.storePresentation({ viewportId });

        // This should be done after the store presentation since synchronizers
        // will get cleaned up and they need the viewportInfo to be present
        cleanUpServices(viewportInfo);

        if (onElementDisabled && typeof onElementDisabled === 'function') {
          onElementDisabled(viewportInfo);
        }

        cornerstoneViewportService.disableElement(viewportId);

        eventTarget.removeEventListener(Enums.Events.ELEMENT_ENABLED, elementEnabledHandler);
      };
    }, []);

    // subscribe to displaySet metadata invalidation (updates)
    // Currently, if the metadata changes we need to re-render the display set
    // for it to take effect in the viewport. As we deal with scaling in the loading,
    // we need to remove the old volume from the cache, and let the
    // viewport to re-add it which will use the new metadata. Otherwise, the
    // viewport will use the cached volume and the new metadata will not be used.
    // Note: this approach does not actually end of sending network requests
    // and it uses the network cache
    useEffect(() => {
      const { unsubscribe } = displaySetService.subscribe(
        displaySetService.EVENTS.DISPLAY_SET_SERIES_METADATA_INVALIDATED,
        async ({
          displaySetInstanceUID: invalidatedDisplaySetInstanceUID,
          invalidateData,
        }: Types.DisplaySetSeriesMetadataInvalidatedEvent) => {
          if (!invalidateData) {
            return;
          }

          const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

          if (viewportInfo.hasDisplaySet(invalidatedDisplaySetInstanceUID)) {
            const viewportData = viewportInfo.getViewportData();
            const newViewportData = await cornerstoneCacheService.invalidateViewportData(
              viewportData,
              invalidatedDisplaySetInstanceUID,
              dataSource,
              displaySetService
            );

            const keepCamera = true;
            cornerstoneViewportService.updateViewport(viewportId, newViewportData, keepCamera);
          }
        }
      );
      return () => {
        unsubscribe();
      };
    }, [viewportId]);

    useEffect(() => {
      // handle the default viewportType to be stack
      if (!viewportOptions.viewportType) {
        viewportOptions.viewportType = STACK;
      }

      const loadViewportData = async () => {
        const viewportData = await cornerstoneCacheService.createViewportData(
          displaySets,
          viewportOptions,
          dataSource,
          initialImageIndex
        );

        const presentations = getViewportPresentations(viewportId, viewportOptions);

        // Note: This is a hack to get the grid to re-render the OHIFCornerstoneViewport component
        // Used for segmentation hydration right now, since the logic to decide whether
        // a viewport needs to render a segmentation lives inside the CornerstoneViewportService
        // so we need to re-render (force update via change of the needsRerendering) so that React
        // does the diffing and decides we should render this again (although the id and element has not changed)
        // so that the CornerstoneViewportService can decide whether to render the segmentation or not. Not that we reached here we can turn it off.
        if (viewportOptions.needsRerendering) {
          viewportOptions.needsRerendering = false;
        }

        cornerstoneViewportService.setViewportData(
          viewportId,
          viewportData,
          viewportOptions,
          displaySetOptions,
          presentations
        );
      };

      loadViewportData();
    }, [viewportOptions, displaySets, dataSource]);

    useEffect(() => {
      if (typeof window === 'undefined') {
        return;
      }

      const intervalId = window.setInterval(() => {
        const latestContourDebug =
          (window as Window & { __oviContourDebugInfo?: string }).__oviContourDebugInfo || '';
        setContourDebugInfo(current =>
          current === latestContourDebug ? current : latestContourDebug
        );
        const latestBrushDebug =
          (window as Window & { __oviBrushDebugInfo?: string }).__oviBrushDebugInfo || '';
        setBrushDebugInfo(current => (current === latestBrushDebug ? current : latestBrushDebug));
        const latestBrushSaveDebug =
          (window as Window & { __oviBrushSaveDebugInfo?: string }).__oviBrushSaveDebugInfo || '';
        setBrushSaveDebugInfo(current =>
          current === latestBrushSaveDebug ? current : latestBrushSaveDebug
        );
      }, 100);

      return () => {
        window.clearInterval(intervalId);
      };
    }, []);

    useEffect(() => {
      const element = elementRef.current;
      if (!element) {
        return;
      }

      const getViewport = () => getEnabledElement(element)?.viewport;
      const getActiveToolName = () => {
        const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);
        const toolGroupId = viewportInfo?.getToolGroupId?.();
        if (!toolGroupId) {
          return null;
        }

        return toolGroupService.getActivePrimaryMouseButtonTool?.(toolGroupId) || null;
      };

      const isContourMode = () => {
        const activeTool = getActiveToolName();
        return activeTool === 'ManualContour' || activeTool === 'MaskContour';
      };

      const isBrushOrEraserMode = () => {
        const activeTool = getActiveToolName() || '';
        return activeTool.includes('Brush') || activeTool.includes('Eraser');
      };

      const stackLabelmapFrameBuffers = new Map<string, Uint8Array>();
      const previousImageIndexBySegmentation = new Map<string, number>();

      const getSegmentationIdsForViewport = () => {
        const segmentationApi = (cs3DTools as any).segmentation;
        const cornerstoneRepresentations =
          segmentationApi?.state?.getSegmentationRepresentations?.(viewportId) ?? [];
        const serviceRepresentations =
          segmentationService?.getSegmentationRepresentations?.(viewportId) ?? [];
        const segmentations =
          segmentationService?.getSegmentations?.() ??
          segmentationApi?.state?.getSegmentations?.() ??
          [];
        return Array.from(
          new Set(
            [...cornerstoneRepresentations, ...serviceRepresentations, ...segmentations]
              .map((item: any) => item?.segmentationId)
              .filter(Boolean)
          )
        ) as string[];
      };

      const rememberCurrentStackLabelmapIndex = () => {
        const viewport = getViewport() as any;
        const currentImageIndex = viewport?.getCurrentImageIdIndex?.();
        if (typeof currentImageIndex !== 'number') {
          return;
        }

        for (const segmentationId of getSegmentationIdsForViewport()) {
          previousImageIndexBySegmentation.set(segmentationId, currentImageIndex);
        }
      };

      const syncReusableStackLabelmapForSliceChange = (segmentationId: string, viewport: any) => {
        const segmentationApi = (cs3DTools as any).segmentation;
        const currentImageIndex = viewport?.getCurrentImageIdIndex?.();
        if (typeof currentImageIndex !== 'number') {
          return false;
        }

        const labelmapImageId =
          segmentationApi?.state?.getCurrentLabelmapImageIdForViewport?.(
            viewportId,
            segmentationId
          );
        if (!labelmapImageId) {
          return false;
        }

        const labelmapImage = cache.getImage(labelmapImageId) as any;
        const scalarData = labelmapImage?.voxelManager?.getScalarData?.() as Uint8Array | undefined;
        if (!scalarData) {
          return false;
        }

        const previousIndex = previousImageIndexBySegmentation.get(segmentationId) ?? currentImageIndex;
        if (previousIndex === currentImageIndex) {
          previousImageIndexBySegmentation.set(segmentationId, currentImageIndex);
          return false;
        }

        stackLabelmapFrameBuffers.set(
          `${segmentationId}:${previousIndex}`,
          new Uint8Array(scalarData)
        );

        const currentKey = `${segmentationId}:${currentImageIndex}`;
        const targetBuffer = stackLabelmapFrameBuffers.get(currentKey);
        if (targetBuffer) {
          scalarData.set(targetBuffer);
        } else {
          scalarData.fill(0);
        }

        previousImageIndexBySegmentation.set(segmentationId, currentImageIndex);
        labelmapImage.imageData?.modified?.();
        labelmapImage.invalidate?.();
        return true;
      };

      const refreshCurrentLabelmapActorsForSliceChange = (eventName: string) => {
        const viewport = getViewport() as any;
        const forceLabelmapOverlayPass = (actor: any) => {
          // Stack labelmap slices are coplanar with the source image; render them in the translucent
          // overlay pass so slice changes do not let the base image occlude the segmentation.
          actor?.setForceTranslucent?.(true);
          actor?.setForceOpaque?.(false);
        };
        const segmentationApi = (cs3DTools as any).segmentation;
        const segmentationIds = getSegmentationIdsForViewport();

        if (!viewport || !segmentationIds.length) {
          return { refreshed: 0, current: 0 };
        }

        let refreshed = 0;
        let current = 0;

        for (const segmentationId of segmentationIds) {
          syncReusableStackLabelmapForSliceChange(segmentationId, viewport);
          const currentLabelmapImageIds =
            segmentationApi?.state?.getCurrentLabelmapImageIdsForViewport?.(
              viewportId,
              segmentationId
            ) ?? [];
          const entries =
            segmentationApi?.helpers?.getLabelmapActorEntries?.(viewportId, segmentationId) ?? [];

          for (const entry of entries) {
            if (!currentLabelmapImageIds.includes(entry?.referencedId)) {
              continue;
            }

            current += 1;
            entry.actor?.setVisibility?.(true);
            forceLabelmapOverlayPass(entry.actor);
            entry.actor?.getProperty?.()?.modified?.();
            entry.actor?.getMapper?.()?.modified?.();
            entry.actor?.modified?.();

            refreshed += 1;
          }
        }

        if (current === 0) {
          const actorEntries = viewport.getActors?.() ?? [];
          for (const entry of actorEntries) {
            if (!entry?.referencedId?.startsWith?.('derived:') || !entry.actor) {
              continue;
            }

            current += 1;
            entry.actor.setVisibility?.(true);
            forceLabelmapOverlayPass(entry.actor);
            entry.actor.getProperty?.()?.modified?.();
            entry.actor.getMapper?.()?.modified?.();
            entry.actor.modified?.();

            refreshed += 1;
          }
        }

        if (refreshed > 0) {
          const render = () => {
            cs3DTools.utilities.segmentation.triggerSegmentationRender?.(viewportId);
            viewport.render?.();
          };
          window.requestAnimationFrame(render);
          window.setTimeout(render, 0);
        }

        const message = `labelmap: slice-change=${eventName} current=${current} refreshed=${refreshed}`;
        (window as Window & { __oviLabelmapDebugInfo?: string }).__oviLabelmapDebugInfo = message;

        return { refreshed, current };
      };

      const invalidateBrushCursorForSliceChange = (eventName: string) => {
        if (!isBrushOrEraserMode()) {
          return;
        }

        const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);
        const toolGroupId = viewportInfo?.getToolGroupId?.();
        if (!toolGroupId) {
          return;
        }

        cs3DTools.utilities.segmentation.invalidateBrushCursor?.(toolGroupId);
        cs3DTools.utilities.segmentation.triggerSegmentationRender?.(viewportId);
        const viewport = getViewport() as any;
        const labelmapRefresh = refreshCurrentLabelmapActorsForSliceChange(eventName);
        const message = `brush/eraser: slice-change=${eventName} tool=${
          getActiveToolName() || 'none'
        } vp=${viewport?.getCurrentImageIdIndex?.() ?? '-'} invalidated=yes labelmap=${
          labelmapRefresh.refreshed
        }/${labelmapRefresh.current}`;
        (window as Window & { __oviBrushDebugInfo?: string }).__oviBrushDebugInfo = message;
        setBrushDebugInfo(message);
      };

      const getDisplaySetReferenceImageIds = () => {
        const displaySet = displaySets?.[0] as any;
        if (displaySet?.isDynamicVolume && displaySet.dynamicVolumeInfo?.timePoints?.length) {
          return displaySet.dynamicVolumeInfo.timePoints.flat();
        }
        return displaySet?.imageIds ?? [];
      };

      const updateBrushDebugFromInput = (eventName: string) => {
        if (!isBrushOrEraserMode()) {
          return;
        }

        const viewport = getViewport() as any;
        const viewportImageIndex = viewport?.getCurrentImageIdIndex?.();
        const viewportImageId = viewport?.getCurrentImageId?.();
        const referenceImageIds = getDisplaySetReferenceImageIds();
        const referenceIndexFromViewportImage =
          viewportImageId && referenceImageIds.length
            ? referenceImageIds.indexOf(viewportImageId)
            : -1;
        const message = `brush/eraser: input=${eventName} tool=${
          getActiveToolName() || 'none'
        } vp=${viewportImageIndex ?? '-'} refVp=${referenceIndexFromViewportImage} modified=-`;

        (window as Window & { __oviBrushDebugInfo?: string }).__oviBrushDebugInfo = message;
        setBrushDebugInfo(message);
      };

      const shouldHandleTouchGesture = () => {
        const activeTool = getActiveToolName();
        return (
          activeTool !== 'Length' &&
          activeTool !== 'Bidirectional' &&
          activeTool !== 'Probe' &&
          activeTool !== 'DebugProbe' &&
          activeTool !== 'EllipticalROI' &&
          activeTool !== 'CircleROI' &&
          activeTool !== 'RectangleROI' &&
          activeTool !== 'RotatableRectangleROI' &&
          activeTool !== 'CalibrationLine'
        );
      };

      const resetGestureState = () => {
        tabletGestureStateRef.current = {
          mode: null,
          scrollAccumulator: 0,
        };
      };

      const clearContourLongPress = () => {
        const timeoutId = contourLongPressRef.current.timeoutId;
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }

        contourLongPressRef.current = {
          fired: false,
        };
      };

      const triggerContourLongPress = (touch: Touch) => {
        const target = element;
        const rightClickEvent = new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: 2,
          clientX: touch.clientX,
          clientY: touch.clientY,
          screenX: touch.screenX,
          screenY: touch.screenY,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
        });

        setInputDebugInfo(`longpress:direct touches=1 activeTool=${getActiveToolName() || 'none'}`);
        target.dispatchEvent(rightClickEvent);
      };

      const triggerAnnotationLongPressMenu = (touch: Touch) => {
        const rect = element.getBoundingClientRect();
        const canvasCoordinates = [touch.clientX - rect.left, touch.clientY - rect.top];
        setInputDebugInfo(
          `longpress:invoke activeTool=${getActiveToolName() || 'none'} point=${Math.round(
            canvasCoordinates[0]
          )},${Math.round(canvasCoordinates[1])}`
        );

        const syntheticEvent = {
          detail: {
            element,
            event: {
              pageX: touch.pageX,
              pageY: touch.pageY,
              clientX: touch.clientX,
              clientY: touch.clientY,
              which: 3,
              button: 2,
              touches: {},
            },
            currentPoints: {
              canvas: canvasCoordinates,
              client: [touch.clientX, touch.clientY],
            },
          },
        };

        commandsManager.runCommand(
          'showOviLabsContextMenu',
          {
            nearbyToolData: null,
            event: syntheticEvent,
          },
          'OVI_LABS'
        );
      };

      const handlePencilDown = (event: PointerEvent) => {
        updateBrushDebugFromInput(event.type);
        setInputDebugInfo(
          `pointerdown:${event.pointerType || 'unknown'} touches=0 activeTool=${getActiveToolName() || 'none'}`
        );
        if (event.pointerType === 'pen') {
          pencilActiveRef.current = true;
        }
      };
      const handlePencilUp = (event: PointerEvent) => {
        updateBrushDebugFromInput(event.type);
        setInputDebugInfo(
          `${event.type}:${event.pointerType || 'unknown'} touches=0 activeTool=${getActiveToolName() || 'none'}`
        );
        if (event.pointerType === 'pen') {
          pencilActiveRef.current = false;
        }
      };

      const formatTouchDebug = (event: TouchEvent) => {
        const firstTouch = event.touches[0] || event.changedTouches[0];
        const inferredType =
          touchListContainsStylus(event.touches) || touchListContainsStylus(event.changedTouches)
            ? 'stylus'
            : touchListContainsDirect(event.touches) ||
                touchListContainsDirect(event.changedTouches)
              ? 'direct'
              : 'finger';
        const touchType = getTouchType(firstTouch) || inferredType;
        return `${event.type}:${touchType} touches=${event.touches.length} changed=${event.changedTouches.length} pencil=${pencilActiveRef.current ? 'yes' : 'no'} activeTool=${getActiveToolName() || 'none'}`;
      };

      const handleTouchStart = (event: TouchEvent) => {
        const isStylusTouch = touchListContainsStylus(event.touches);
        const isDirectTouch = touchListContainsDirect(event.touches);
        updateBrushDebugFromInput(event.type);
        setInputDebugInfo(formatTouchDebug(event));

        if (isDirectTouch && event.touches.length === 1) {
          const firstTouch = event.touches[0];
          clearContourLongPress();
          if (firstTouch) {
            contourLongPressRef.current.startPoint = normalizeTouchPoint(firstTouch);
            contourLongPressRef.current.timeoutId = window.setTimeout(() => {
              contourLongPressRef.current.fired = true;
              triggerAnnotationLongPressMenu(firstTouch);
            }, CONTOUR_LONG_PRESS_MS);
          }
        } else {
          clearContourLongPress();
        }

        if (isContourMode() && isDirectTouch) {
          if (event.touches.length >= 2) {
            const touches = getTouchArray(event.touches);
            const state = tabletGestureStateRef.current;
            state.mode = null;
            state.lastTouches = touches.map(normalizeTouchPoint);
            state.lastDistance = getTouchDistance(touches);
            state.scrollAccumulator = 0;
          } else {
            resetGestureState();
          }

          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }

        // Palm rejection: suppress finger-only touches while pencil is in contact,
        // but still allow stylus-originated touch events to reach the drawing tool.
        if (pencilActiveRef.current && !isStylusTouch) {
          event.preventDefault();
          event.stopImmediatePropagation();
          resetGestureState();
          return;
        }
        if (!shouldHandleTouchGesture()) {
          resetGestureState();
          return;
        }

        const touches = getTouchArray(event.touches);
        if (!touches.length) {
          return;
        }

        const state = tabletGestureStateRef.current;
        if (touches.length === 2) {
          state.mode = null;
          state.lastTouches = touches.map(normalizeTouchPoint);
          state.lastDistance = getTouchDistance(touches);
          state.scrollAccumulator = 0;
          event.preventDefault();
          return;
        }

        resetGestureState();
      };

      const handleTouchMove = (event: TouchEvent) => {
        const isStylusTouch = touchListContainsStylus(event.touches);
        const isDirectTouch = touchListContainsDirect(event.touches);
        setInputDebugInfo(formatTouchDebug(event));

        if (isDirectTouch && event.touches.length === 1) {
          const currentPoint = normalizeTouchPoint(event.touches[0]);
          const startPoint = contourLongPressRef.current.startPoint;
          if (startPoint) {
            const distance = Math.hypot(
              currentPoint.x - startPoint.x,
              currentPoint.y - startPoint.y
            );
            if (distance > CONTOUR_LONG_PRESS_MOVE_CANCEL_PX) {
              clearContourLongPress();
            }
          }
        } else if (event.touches.length !== 1) {
          clearContourLongPress();
        }

        if (isContourMode() && isDirectTouch) {
          const viewport = getViewport();
          if (!viewport) {
            clearContourLongPress();
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }

          const touches = getTouchArray(event.touches);
          const state = tabletGestureStateRef.current;

          if (touches.length === 1) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }

          if (touches.length >= 2 && state.lastTouches?.length >= 2) {
            clearContourLongPress();
            event.preventDefault();
            event.stopImmediatePropagation();

            const previousTouches = state.lastTouches.slice(0, 2);
            const currentTouches = touches.slice(0, 2).map(normalizeTouchPoint);
            const currentDistance = getTouchDistance(touches.slice(0, 2) as Touch[]);
            const distanceDelta = currentDistance - (state.lastDistance || currentDistance);

            const touchOneDx = currentTouches[0].x - previousTouches[0].x;
            const touchOneDy = currentTouches[0].y - previousTouches[0].y;
            const touchTwoDx = currentTouches[1].x - previousTouches[1].x;
            const touchTwoDy = currentTouches[1].y - previousTouches[1].y;
            const averageDx = (touchOneDx + touchTwoDx) / 2;
            const averageDy = (touchOneDy + touchTwoDy) / 2;
            const averageMotion = Math.hypot(averageDx, averageDy);
            const sameDirectionVerticalMotion = touchOneDy * touchTwoDy > 0;
            const sameDirectionMotion = touchOneDx * touchTwoDx + touchOneDy * touchTwoDy > 0;
            const parallelVerticalMotion =
              sameDirectionVerticalMotion &&
              Math.abs(averageDy) >= TABLET_SCROLL_LOCK_THRESHOLD_PX &&
              Math.abs(averageDy) > Math.abs(averageDx) * 1.5 &&
              Math.abs(touchOneDx) <= TABLET_SCROLL_MAX_HORIZONTAL_DRIFT_PX &&
              Math.abs(touchTwoDx) <= TABLET_SCROLL_MAX_HORIZONTAL_DRIFT_PX &&
              Math.abs(touchOneDy - touchTwoDy) <= TABLET_SCROLL_MAX_VERTICAL_DELTA_MISMATCH_PX &&
              Math.abs(distanceDelta) <= TABLET_ZOOM_THRESHOLD_PX;
            const pinchZoomMotion =
              Math.abs(distanceDelta) >= TABLET_ZOOM_LOCK_THRESHOLD_PX &&
              Math.abs(distanceDelta) > averageMotion * 0.75;
            const panMotion =
              sameDirectionMotion &&
              averageMotion >= TABLET_PAN_LOCK_THRESHOLD_PX &&
              Math.max(Math.abs(averageDx), Math.abs(averageDy)) >= TABLET_PAN_LOCK_THRESHOLD_PX &&
              Math.abs(averageDy) < Math.abs(averageDx) * 1.35 &&
              !parallelVerticalMotion &&
              !pinchZoomMotion;

            if (parallelVerticalMotion) {
              state.mode = 'scroll';
            } else if (pinchZoomMotion) {
              state.mode = 'zoom';
            } else if (panMotion) {
              state.mode = 'pan';
            } else if (!state.mode) {
              state.lastTouches = currentTouches;
              state.lastDistance = currentDistance;
              return;
            }

            if (state.mode === 'scroll') {
              state.scrollAccumulator += averageDy;

              while (Math.abs(state.scrollAccumulator) >= TABLET_SCROLL_STEP_PX) {
                const direction = state.scrollAccumulator > 0 ? 1 : -1;
                csUtils.scroll(viewport, { delta: direction });
                state.scrollAccumulator -= TABLET_SCROLL_STEP_PX * direction;
              }
            } else if (state.mode === 'zoom') {
              const currentCamera = viewport.getCamera?.();
              const parallelScale = currentCamera?.parallelScale;
              if (parallelScale && state.lastDistance && currentDistance > 0) {
                viewport.setCamera({
                  parallelScale: parallelScale * (state.lastDistance / currentDistance),
                });
                viewport.render();
              }
            } else if (state.mode === 'pan') {
              const rect = element.getBoundingClientRect();
              const previousCenter = getTouchCenter(previousTouches);
              const currentCenter = getTouchCenter(currentTouches);
              const previousCanvasPoint = [
                previousCenter.x - rect.left,
                previousCenter.y - rect.top,
              ];
              const currentCanvasPoint = [currentCenter.x - rect.left, currentCenter.y - rect.top];
              const previousWorldPoint = viewport.canvasToWorld?.(previousCanvasPoint);
              const currentWorldPoint = viewport.canvasToWorld?.(currentCanvasPoint);
              const currentCamera = viewport.getCamera?.();

              if (
                previousWorldPoint &&
                currentWorldPoint &&
                currentCamera?.focalPoint &&
                currentCamera?.position
              ) {
                const worldDelta = [
                  previousWorldPoint[0] - currentWorldPoint[0],
                  previousWorldPoint[1] - currentWorldPoint[1],
                  previousWorldPoint[2] - currentWorldPoint[2],
                ];

                viewport.setCamera({
                  focalPoint: currentCamera.focalPoint.map(
                    (value, index) => value + worldDelta[index]
                  ),
                  position: currentCamera.position.map((value, index) => value + worldDelta[index]),
                });
                viewport.render();
              }
            }

            state.lastTouches = currentTouches;
            state.lastDistance = currentDistance;
            return;
          }

          event.preventDefault();
          event.stopImmediatePropagation();
          clearContourLongPress();
          resetGestureState();
          return;
        }

        if (pencilActiveRef.current && !isStylusTouch) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (!shouldHandleTouchGesture()) {
          return;
        }

        const viewport = getViewport();
        if (!viewport) {
          return;
        }

        const touches = getTouchArray(event.touches);
        const state = tabletGestureStateRef.current;

        if (touches.length === 2 && state.lastTouches?.length === 2) {
          event.preventDefault();

          const previousTouches = state.lastTouches;
          const currentTouches = touches.map(normalizeTouchPoint);
          const currentDistance = getTouchDistance(touches);
          const distanceDelta = currentDistance - (state.lastDistance || currentDistance);

          const touchOneDx = currentTouches[0].x - previousTouches[0].x;
          const touchOneDy = currentTouches[0].y - previousTouches[0].y;
          const touchTwoDx = currentTouches[1].x - previousTouches[1].x;
          const touchTwoDy = currentTouches[1].y - previousTouches[1].y;
          const averageDx = (touchOneDx + touchTwoDx) / 2;
          const averageDy = (touchOneDy + touchTwoDy) / 2;
          const averageMotion = Math.hypot(averageDx, averageDy);
          const sameDirectionVerticalMotion = touchOneDy * touchTwoDy > 0;
          const sameDirectionMotion = touchOneDx * touchTwoDx + touchOneDy * touchTwoDy > 0;
          const parallelVerticalMotion =
            sameDirectionVerticalMotion &&
            Math.abs(averageDy) >= TABLET_SCROLL_LOCK_THRESHOLD_PX &&
            Math.abs(averageDy) > Math.abs(averageDx) * 1.5 &&
            Math.abs(touchOneDx) <= TABLET_SCROLL_MAX_HORIZONTAL_DRIFT_PX &&
            Math.abs(touchTwoDx) <= TABLET_SCROLL_MAX_HORIZONTAL_DRIFT_PX &&
            Math.abs(touchOneDy - touchTwoDy) <= TABLET_SCROLL_MAX_VERTICAL_DELTA_MISMATCH_PX &&
            Math.abs(distanceDelta) <= TABLET_ZOOM_THRESHOLD_PX;
          const pinchZoomMotion =
            Math.abs(distanceDelta) >= TABLET_ZOOM_LOCK_THRESHOLD_PX &&
            Math.abs(distanceDelta) > averageMotion * 0.75;
          const panMotion =
            sameDirectionMotion &&
            averageMotion >= TABLET_PAN_LOCK_THRESHOLD_PX &&
            Math.max(Math.abs(averageDx), Math.abs(averageDy)) >= TABLET_PAN_LOCK_THRESHOLD_PX &&
            Math.abs(averageDy) < Math.abs(averageDx) * 1.35 &&
            !parallelVerticalMotion &&
            !pinchZoomMotion;

          if (parallelVerticalMotion) {
            state.mode = 'scroll';
          } else if (pinchZoomMotion) {
            state.mode = 'zoom';
          } else if (panMotion) {
            state.mode = 'pan';
          } else if (!state.mode) {
            state.lastTouches = currentTouches;
            state.lastDistance = currentDistance;
            return;
          }

          if (state.mode === 'scroll') {
            state.scrollAccumulator += averageDy;

            while (Math.abs(state.scrollAccumulator) >= TABLET_SCROLL_STEP_PX) {
              const direction = state.scrollAccumulator > 0 ? 1 : -1;
              csUtils.scroll(viewport, { delta: direction });
              state.scrollAccumulator -= TABLET_SCROLL_STEP_PX * direction;
            }
          } else if (state.mode === 'zoom') {
            const currentCamera = viewport.getCamera?.();
            const parallelScale = currentCamera?.parallelScale;
            if (parallelScale && state.lastDistance && currentDistance > 0) {
              viewport.setCamera({
                parallelScale: parallelScale * (state.lastDistance / currentDistance),
              });
              viewport.render();
            }
          } else if (state.mode === 'pan') {
            const rect = element.getBoundingClientRect();
            const previousCenter = getTouchCenter(previousTouches);
            const currentCenter = getTouchCenter(currentTouches);
            const previousCanvasPoint = [previousCenter.x - rect.left, previousCenter.y - rect.top];
            const currentCanvasPoint = [currentCenter.x - rect.left, currentCenter.y - rect.top];
            const previousWorldPoint = viewport.canvasToWorld?.(previousCanvasPoint);
            const currentWorldPoint = viewport.canvasToWorld?.(currentCanvasPoint);
            const currentCamera = viewport.getCamera?.();

            if (
              previousWorldPoint &&
              currentWorldPoint &&
              currentCamera?.focalPoint &&
              currentCamera?.position
            ) {
              const worldDelta = [
                previousWorldPoint[0] - currentWorldPoint[0],
                previousWorldPoint[1] - currentWorldPoint[1],
                previousWorldPoint[2] - currentWorldPoint[2],
              ];

              viewport.setCamera({
                focalPoint: currentCamera.focalPoint.map(
                  (value, index) => value + worldDelta[index]
                ),
                position: currentCamera.position.map((value, index) => value + worldDelta[index]),
              });
              viewport.render();
            }
          }

          state.lastTouches = currentTouches;
          state.lastDistance = currentDistance;
          return;
        }
      };

      const handleTouchEnd = (event: TouchEvent) => {
        updateBrushDebugFromInput(event.type);
        setInputDebugInfo(formatTouchDebug(event));
        if (isContourMode() && touchListContainsDirect(event.changedTouches)) {
          clearContourLongPress();
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        resetGestureState();
      };

      const handleContextMenu = (event: MouseEvent) => {
        const rect = element.getBoundingClientRect();
        const canvasCoordinates = [event.clientX - rect.left, event.clientY - rect.top];
        const nearbyToolData = commandsManager.runCommand(
          'getNearbyToolData',
          {
            element,
            canvasCoordinates,
          },
          'CORNERSTONE'
        );

        setInputDebugInfo(
          `contextmenu:button=${event.button} activeTool=${getActiveToolName() || 'none'} picked=${nearbyToolData?.metadata?.toolName || 'none'}`
        );

        if (isContourMode()) {
          const syntheticEvent = {
            detail: {
              element,
              event: {
                pageX: event.pageX,
                pageY: event.pageY,
                clientX: event.clientX,
                clientY: event.clientY,
                which: 3,
                button: 2,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                metaKey: event.metaKey,
              },
              currentPoints: {
                canvas: canvasCoordinates,
                client: [event.clientX, event.clientY],
              },
            },
          };

          commandsManager.runCommand(
            'showOviLabsContextMenu',
            {
              nearbyToolData,
              event: syntheticEvent,
            },
            'OVI_LABS'
          );
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };

      const handleMouseDown = (event: MouseEvent) => {
        updateBrushDebugFromInput(event.type);
        if (isBrushOrEraserMode()) {
          rememberCurrentStackLabelmapIndex();
        }
        if (event.button === 2) {
          setInputDebugInfo(`mousedown:right activeTool=${getActiveToolName() || 'none'}`);
        }
      };

      const handleViewportSliceChanged = (event: Event) => {
        refreshCurrentLabelmapActorsForSliceChange(event.type);
        invalidateBrushCursorForSliceChange(event.type);
      };

      const { unsubscribe: unsubscribeSegmentationDataModified } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
        rememberCurrentStackLabelmapIndex
      );

      element.addEventListener('mousedown', handleMouseDown, true);
      element.addEventListener('contextmenu', handleContextMenu, true);
      element.addEventListener(Enums.Events.STACK_NEW_IMAGE, handleViewportSliceChanged);
      element.addEventListener(Enums.Events.STACK_VIEWPORT_SCROLL, handleViewportSliceChanged);
      element.addEventListener(Enums.Events.VOLUME_NEW_IMAGE, handleViewportSliceChanged);

      if (!isTouchCapableDevice()) {
        return () => {
          unsubscribeSegmentationDataModified?.();
          element.removeEventListener('mousedown', handleMouseDown, true);
          element.removeEventListener('contextmenu', handleContextMenu, true);
          element.removeEventListener(Enums.Events.STACK_NEW_IMAGE, handleViewportSliceChanged);
          element.removeEventListener(
            Enums.Events.STACK_VIEWPORT_SCROLL,
            handleViewportSliceChanged
          );
          element.removeEventListener(Enums.Events.VOLUME_NEW_IMAGE, handleViewportSliceChanged);
        };
      }

      element.addEventListener('pointerdown', handlePencilDown);
      element.addEventListener('pointerup', handlePencilUp);
      element.addEventListener('pointercancel', handlePencilUp);
      element.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
      element.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
      element.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
      element.addEventListener('touchcancel', handleTouchEnd, { passive: false, capture: true });

      return () => {
        unsubscribeSegmentationDataModified?.();
        clearContourLongPress();
        element.removeEventListener('mousedown', handleMouseDown, true);
        element.removeEventListener('contextmenu', handleContextMenu, true);
        element.removeEventListener(Enums.Events.STACK_NEW_IMAGE, handleViewportSliceChanged);
        element.removeEventListener(Enums.Events.STACK_VIEWPORT_SCROLL, handleViewportSliceChanged);
        element.removeEventListener(Enums.Events.VOLUME_NEW_IMAGE, handleViewportSliceChanged);
        element.removeEventListener('pointerdown', handlePencilDown);
        element.removeEventListener('pointerup', handlePencilUp);
        element.removeEventListener('pointercancel', handlePencilUp);
        element.removeEventListener('touchstart', handleTouchStart, true);
        element.removeEventListener('touchmove', handleTouchMove, true);
        element.removeEventListener('touchend', handleTouchEnd, true);
        element.removeEventListener('touchcancel', handleTouchEnd, true);
      };
    }, [viewportId, cornerstoneViewportService, toolGroupService]);

    /**
     * There are two scenarios for jump to click
     * 1. Current viewports contain the displaySet that the annotation was drawn on
     * 2. Current viewports don't contain the displaySet that the annotation was drawn on
     * and we need to change the viewports displaySet for jumping.
     * Since measurement_jump happens via events and listeners, the former case is handled
     * by the measurement_jump direct callback, but the latter case is handled first by
     * the viewportGrid to set the correct displaySet on the viewport, AND THEN we check
     * the cache for jumping to see if there is any jump queued, then we jump to the correct slice.
     */
    useEffect(() => {
      if (isJumpToMeasurementDisabled) {
        return;
      }

      const { unsubscribe } = measurementService.subscribe(
        MeasurementService.EVENTS.JUMP_TO_MEASUREMENT_VIEWPORT,
        event => handleJumpToMeasurement(event, elementRef, viewportId, cornerstoneViewportService)
      );

      return () => {
        unsubscribe();
      };
    }, [displaySets, elementRef, viewportId, isJumpToMeasurementDisabled, servicesManager]);

    // Set up the window level action menu in the viewport action corners.
    useEffect(() => {
      const windowLevelActionMenu = customizationService.getCustomization(
        'viewportActionMenu.windowLevelActionMenu'
      );
      const segmentationOverlay = customizationService.getCustomization(
        'viewportActionMenu.segmentationOverlay'
      );

      if (windowLevelActionMenu?.enabled) {
        viewportActionCornersService.addComponent({
          viewportId,
          id: 'windowLevelActionMenu',
          component: getWindowLevelActionMenu({
            viewportId,
            element: elementRef.current,
            displaySets,
            servicesManager,
            commandsManager,
            location: windowLevelActionMenu.location,
            verticalDirection: AllInOneMenu.VerticalDirection.TopToBottom,
            horizontalDirection: AllInOneMenu.HorizontalDirection.RightToLeft,
          }),
          location: windowLevelActionMenu.location,
        });
      }

      if (segmentationOverlay?.enabled) {
        viewportActionCornersService.addComponent({
          viewportId,
          id: 'segmentation',
          component: getViewportDataOverlaySettingsMenu({
            viewportId,
            element: elementRef.current,
            displaySets,
            servicesManager,
            commandsManager,
            location: segmentationOverlay.location,
          }),
          location: segmentationOverlay.location,
        });
      }
    }, [displaySets, viewportId, viewportActionCornersService, servicesManager, commandsManager]);

    const { ref: resizeRef } = useResizeDetector({
      onResize,
    });

    const Notification = customizationService.getCustomization('ui.notificationComponent');

    return (
      <React.Fragment>
        <div className="viewport-wrapper">
          <div
            className="cornerstone-viewport-element"
            style={{
              height: '100%',
              width: '100%',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
            }}
            onContextMenu={e => e.preventDefault()}
            onMouseDown={e => e.preventDefault()}
            onSelectStart={e => e.preventDefault()}
            onDragStart={e => e.preventDefault()}
            ref={el => {
              resizeRef.current = el;
              elementRef.current = el;
            }}
          ></div>
          <CornerstoneOverlays
            viewportId={viewportId}
            toolBarService={toolbarService}
            element={elementRef.current}
            scrollbarHeight={scrollbarHeight}
            servicesManager={servicesManager}
          />
          <CinePlayer
            enabledVPElement={enabledVPElement}
            viewportId={viewportId}
            servicesManager={servicesManager}
          />
          <ActiveViewportBehavior
            viewportId={viewportId}
            servicesManager={servicesManager}
          />
        </div>
        {/* top offset of 24px to account for ViewportActionCorners. */}
        <div className="absolute top-[24px] w-full">
          {viewportDialogState.viewportId === viewportId && (
            <Notification
              id="viewport-notification"
              message={viewportDialogState.message}
              type={viewportDialogState.type}
              actions={viewportDialogState.actions}
              onSubmit={viewportDialogState.onSubmit}
              onOutsideClick={viewportDialogState.onOutsideClick}
              onKeyPress={viewportDialogState.onKeyPress}
            />
          )}
        </div>
        <div
          className={`pointer-events-none absolute left-2 z-40 max-w-[80%] rounded bg-black/70 px-2 py-1 font-mono text-[10px] leading-tight text-white ${
            isTouchCapableDevice() ? 'top-2' : 'bottom-2'
          }`}
        >
          <div>{inputDebugInfo || 'input: idle'}</div>
          <div>{contourDebugInfo || 'contour: idle'}</div>
          <div>{brushDebugInfo || 'brush/eraser: idle'}</div>
          <div>{brushSaveDebugInfo || 'save: idle'}</div>
        </div>
        {/* The OHIFViewportActionCorners follows the viewport in the DOM so that it is naturally at a higher z-index.*/}
        <OHIFViewportActionCorners viewportId={viewportId} />
      </React.Fragment>
    );
  },
  areEqual
);

// Helper function to handle jumping to measurements
function handleJumpToMeasurement(event, elementRef, viewportId, cornerstoneViewportService) {
  const { measurement, isConsumed } = event;
  if (!measurement || isConsumed) {
    return;
  }

  const enabledElement = getEnabledElement(elementRef.current);

  if (!enabledElement) {
    return;
  }

  const viewport = enabledElement.viewport as csTypes.IStackViewport | csTypes.IVolumeViewport;

  const { metadata, displaySetInstanceUID } = measurement;

  const viewportDisplaySets = cornerstoneViewportService.getViewportDisplaySets(viewportId);

  const showingDisplaySet = viewportDisplaySets.find(
    ds => ds.displaySetInstanceUID === displaySetInstanceUID
  );

  let metadataToUse = metadata;
  // if it is not showing the displaySet we need to remove the FOR from the metadata
  if (!showingDisplaySet) {
    metadataToUse = {
      ...metadata,
      FrameOfReferenceUID: undefined,
    };
  }

  // Todo: make it work with cases where we want to define FOR based measurements too
  if (!viewport.isReferenceViewable(metadataToUse, WITH_NAVIGATION)) {
    return;
  }

  try {
    viewport.setViewReference(metadata);
    viewport.render();
  } catch (e) {
    console.warn('Unable to apply', metadata, e);
  }

  cs3DTools.annotation.selection.setAnnotationSelected(measurement.uid);
  event?.consume?.();
}

function _rehydrateSynchronizers(viewportId: string, syncGroupService: any) {
  const { synchronizersStore } = useSynchronizersStore.getState();
  const synchronizers = synchronizersStore[viewportId];

  if (!synchronizers) {
    return;
  }

  synchronizers.forEach(synchronizerObj => {
    if (!synchronizerObj.id) {
      return;
    }

    const { id, sourceViewports, targetViewports } = synchronizerObj;

    const synchronizer = syncGroupService.getSynchronizer(id);

    if (!synchronizer) {
      return;
    }

    const sourceViewportInfo = sourceViewports.find(
      sourceViewport => sourceViewport.viewportId === viewportId
    );

    const targetViewportInfo = targetViewports.find(
      targetViewport => targetViewport.viewportId === viewportId
    );

    const isSourceViewportInSynchronizer = synchronizer
      .getSourceViewports()
      .find(sourceViewport => sourceViewport.viewportId === viewportId);

    const isTargetViewportInSynchronizer = synchronizer
      .getTargetViewports()
      .find(targetViewport => targetViewport.viewportId === viewportId);

    // if the viewport was previously a source viewport, add it again
    if (sourceViewportInfo && !isSourceViewportInSynchronizer) {
      synchronizer.addSource({
        viewportId: sourceViewportInfo.viewportId,
        renderingEngineId: sourceViewportInfo.renderingEngineId,
      });
    }

    // if the viewport was previously a target viewport, add it again
    if (targetViewportInfo && !isTargetViewportInSynchronizer) {
      synchronizer.addTarget({
        viewportId: targetViewportInfo.viewportId,
        renderingEngineId: targetViewportInfo.renderingEngineId,
      });
    }
  });
}

// Component displayName
OHIFCornerstoneViewport.displayName = 'OHIFCornerstoneViewport';

function areEqual(prevProps, nextProps) {
  if (nextProps.needsRerendering) {
    console.debug('OHIFCornerstoneViewport: Rerender caused by: needsRerendering');
    return false;
  }

  if (prevProps.displaySets.length !== nextProps.displaySets.length) {
    console.debug('OHIFCornerstoneViewport: Rerender caused by: displaySets length change');
    return false;
  }

  if (prevProps.viewportOptions.orientation !== nextProps.viewportOptions.orientation) {
    console.debug('OHIFCornerstoneViewport: Rerender caused by: orientation change');
    return false;
  }

  if (prevProps.viewportOptions.toolGroupId !== nextProps.viewportOptions.toolGroupId) {
    console.debug('OHIFCornerstoneViewport: Rerender caused by: toolGroupId change');
    return false;
  }

  if (
    nextProps.viewportOptions.viewportType &&
    prevProps.viewportOptions.viewportType !== nextProps.viewportOptions.viewportType
  ) {
    console.debug('OHIFCornerstoneViewport: Rerender caused by: viewportType change');
    return false;
  }

  if (nextProps.viewportOptions.needsRerendering) {
    console.debug('OHIFCornerstoneViewport: Rerender caused by: viewportOptions.needsRerendering');
    return false;
  }

  const prevDisplaySets = prevProps.displaySets;
  const nextDisplaySets = nextProps.displaySets;

  if (prevDisplaySets.length !== nextDisplaySets.length) {
    console.debug('OHIFCornerstoneViewport: Rerender caused by: displaySets length mismatch');
    return false;
  }

  for (let i = 0; i < prevDisplaySets.length; i++) {
    const prevDisplaySet = prevDisplaySets[i];

    const foundDisplaySet = nextDisplaySets.find(
      nextDisplaySet =>
        nextDisplaySet.displaySetInstanceUID === prevDisplaySet.displaySetInstanceUID
    );

    if (!foundDisplaySet) {
      console.debug('OHIFCornerstoneViewport: Rerender caused by: displaySet not found');
      return false;
    }

    // check they contain the same image
    if (foundDisplaySet.images?.length !== prevDisplaySet.images?.length) {
      console.debug('OHIFCornerstoneViewport: Rerender caused by: images length mismatch');
      return false;
    }

    // check if their imageIds are the same
    if (foundDisplaySet.images?.length) {
      for (let j = 0; j < foundDisplaySet.images.length; j++) {
        if (foundDisplaySet.images[j].imageId !== prevDisplaySet.images[j].imageId) {
          console.debug('OHIFCornerstoneViewport: Rerender caused by: imageId mismatch');
          return false;
        }
      }
    }
  }

  return true;
}

// Helper function to check if display sets have changed
function haveDisplaySetsChanged(prevDisplaySets, currentDisplaySets) {
  if (prevDisplaySets.length !== currentDisplaySets.length) {
    return true;
  }

  return currentDisplaySets.some((currentDS, index) => {
    const prevDS = prevDisplaySets[index];
    return currentDS.displaySetInstanceUID !== prevDS.displaySetInstanceUID;
  });
}

export default OHIFCornerstoneViewport;
