import { getEnabledElement } from '@cornerstonejs/core';
import { RectangleROITool, annotation, cursors, drawing, Enums, utilities } from '@cornerstonejs/tools';

const ROTATION_HANDLE_INDEX = 4;
const DEFAULT_ROTATION_HANDLE_OFFSET = 24;
const HANDLE_PROXIMITY = 6;
const ROTATION_CURSOR_NAME = 'RotatableRectangleROI.Rotate';

/**
 * Rotatable Rectangle ROI Tool
 *
 * Extends RectangleROITool with a rotation handle and rotated-resize logic.
 */
class RotatableRectangleROITool extends RectangleROITool {
  static toolName = 'RotatableRectangleROI';

  private rotationHandleOffset: number;

  constructor(toolProps = {}, defaultToolProps = {}) {
    super(toolProps, defaultToolProps);

    this.rotationHandleOffset =
      toolProps?.configuration?.rotationHandleOffset ?? DEFAULT_ROTATION_HANDLE_OFFSET;

    const baseAddNewAnnotation = this.addNewAnnotation;
    const baseRenderAnnotation = this.renderAnnotation;
    const baseDragCallback = this._dragCallback;
    const baseEndCallback = this._endCallback;
    const baseToolSelectedCallback = this.toolSelectedCallback;
    const baseHandleSelectedCallback = this.handleSelectedCallback;
    const baseMouseMoveCallback = this.mouseMoveCallback;
    const baseIsPointNearTool = this.isPointNearTool?.bind(this);

    cursors.registerCursor(
      ROTATION_CURSOR_NAME,
      '<g fill="none" stroke="{{color}}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M52 20A20 20 0 0 0 12 24" />' +
        '<path d="M12 24L6 10L20 16" />' +
        '<path d="M12 44A20 20 0 0 0 52 40" />' +
        '<path d="M52 40L58 54L44 48" />' +
        '</g>',
      { x: 64, y: 64 }
    );

    this.addNewAnnotation = evt => {
      const { element, currentPoints } = evt.detail || {};
      const canvasCoords = currentPoints?.canvas;

      if (element && canvasCoords) {
        const nearbyAnnotation = this._getAnnotationNearPoint(element, canvasCoords);
        if (nearbyAnnotation) {
          return nearbyAnnotation;
        }
      }

      const newAnnotation = baseAddNewAnnotation(evt);

      if (element && newAnnotation) {
        const enabledElement = getEnabledElement(element);
        if (enabledElement?.viewport) {
          this._ensureRotationHandle(newAnnotation, enabledElement.viewport);
        }

        const cursor = cursors.MouseCursor.getDefinedCursor('crosshair');
        if (cursor) {
          cursors.elementCursor.setElementCursor(element, cursor);
        }
      }

      return newAnnotation;
    };

    this.toolSelectedCallback = (evt, selectedAnnotation) => {
      baseToolSelectedCallback(evt, selectedAnnotation);

      const element = evt.detail?.element;
      if (!element) {
        return;
      }

      const cursor = cursors.MouseCursor.getDefinedCursor('move');
      if (cursor) {
        cursors.elementCursor.setElementCursor(element, cursor);
      }
    };

    this.handleSelectedCallback = (evt, selectedAnnotation, handle) => {
      baseHandleSelectedCallback(evt, selectedAnnotation, handle);

      const element = evt.detail?.element;
      const handleIndex = this.editData?.handleIndex;
      const enabledElement = element ? getEnabledElement(element) : null;

      if (!element || !enabledElement?.viewport || handleIndex === undefined || handleIndex === null) {
        return;
      }

      if (handleIndex === ROTATION_HANDLE_INDEX) {
        cursors.setCursorForElement(element, ROTATION_CURSOR_NAME);
        return;
      }

      const cursorName = this._getResizeCursorForHandle(
        selectedAnnotation,
        enabledElement.viewport,
        handleIndex
      );
      const cursor = cursors.MouseCursor.getDefinedCursor(cursorName);

      if (cursor) {
        cursors.elementCursor.setElementCursor(element, cursor);
      }
    };

    this.isPointNearTool = (element, annotationToTest, canvasCoords, proximity, interactionType) => {
      if (baseIsPointNearTool?.(element, annotationToTest, canvasCoords, proximity, interactionType)) {
        return true;
      }

      const enabledElement = getEnabledElement(element);
      if (!enabledElement?.viewport) {
        return false;
      }

      return this._isPointInsideAnnotation(annotationToTest, enabledElement.viewport, canvasCoords);
    };

    this.mouseMoveCallback = (evt, filteredAnnotations) => {
      const needsRedraw = baseMouseMoveCallback(evt, filteredAnnotations);

      if (!filteredAnnotations?.length) {
        return needsRedraw;
      }

      const { element, currentPoints } = evt.detail;
      const canvasCoords = currentPoints.canvas;
      const enabledElement = getEnabledElement(element);
      const { viewport } = enabledElement;

      let cursorName = null;

      for (const currentAnnotation of filteredAnnotations) {
        if (currentAnnotation.isLocked || !currentAnnotation.isVisible) {
          continue;
        }

        const handle = this.getHandleNearImagePoint(
          element,
          currentAnnotation,
          canvasCoords,
          HANDLE_PROXIMITY
        );

        if (handle) {
          const handleIndex = currentAnnotation.data?.handles?.activeHandleIndex;
          if (handleIndex === ROTATION_HANDLE_INDEX) {
            cursorName = ROTATION_CURSOR_NAME;
          } else if (handleIndex !== null && handleIndex !== undefined) {
            cursorName = this._getResizeCursorForHandle(
              currentAnnotation,
              viewport,
              handleIndex
            );
          }
          break;
        }

        const insideTool = this._isPointInsideAnnotation(
          currentAnnotation,
          viewport,
          canvasCoords
        );
        const nearTool = this.isPointNearTool(
          element,
          currentAnnotation,
          canvasCoords,
          HANDLE_PROXIMITY,
          'mouse'
        );

        if (insideTool || nearTool) {
          cursorName = 'move';
          break;
        }
      }

      if (cursorName === ROTATION_CURSOR_NAME) {
        cursors.setCursorForElement(element, ROTATION_CURSOR_NAME);
      } else {
        const cursor = cursors.MouseCursor.getDefinedCursor(cursorName || 'auto');
        if (cursor) {
          cursors.elementCursor.setElementCursor(element, cursor);
        }
      }

      return needsRedraw;
    };

    this._dragCallback = evt => {
      if (this.editData?.newAnnotation) {
        baseDragCallback(evt);

        const element = evt.detail?.element;
        const enabledElement = element ? getEnabledElement(element) : null;
        if (enabledElement?.viewport && this.editData?.annotation) {
          this._ensureRotationHandle(this.editData.annotation, enabledElement.viewport);
        }

        return;
      }

      this.isDrawing = true;
      const eventDetail = evt.detail;
      const { element } = eventDetail;
      const { annotation: currentAnnotation } = this.editData || {};

      if (!currentAnnotation) {
        return;
      }

      const {
        viewportIdsToRender,
        handleIndex,
        movingTextBox,
        newAnnotation,
      } = this.editData;

      this.createMemo(element, currentAnnotation, { newAnnotation });

      const { data } = currentAnnotation;

      if (movingTextBox) {
        const { deltaPoints } = eventDetail;
        const worldPosDelta = deltaPoints.world;
        const { textBox } = data.handles;
        const { worldPosition } = textBox;
        worldPosition[0] += worldPosDelta[0];
        worldPosition[1] += worldPosDelta[1];
        worldPosition[2] += worldPosDelta[2];
        textBox.hasMoved = true;
      } else if (handleIndex === undefined) {
        const { deltaPoints } = eventDetail;
        const worldPosDelta = deltaPoints.world;
        const { points } = data.handles;
        points.forEach(point => {
          point[0] += worldPosDelta[0];
          point[1] += worldPosDelta[1];
          point[2] += worldPosDelta[2];
        });
        currentAnnotation.invalidated = true;
      } else if (handleIndex === ROTATION_HANDLE_INDEX) {
        this._dragRotationHandle(evt);
      } else {
        this._dragResizeHandle(evt);
      }

      this.editData.hasMoved = true;

      const enabledElement = getEnabledElement(element);
      if (enabledElement?.viewport) {
        this._ensureRotationHandle(currentAnnotation, enabledElement.viewport);
      }

      utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
      if (currentAnnotation.invalidated) {
        annotation.state.triggerAnnotationModified(
          currentAnnotation,
          element,
          Enums.ChangeTypes.HandlesUpdated
        );
      }
    };

    this._endCallback = evt => {
      baseEndCallback(evt);

      const element = evt.detail?.element;
      if (!element) {
        return;
      }

      const cursor = cursors.MouseCursor.getDefinedCursor('auto');
      if (cursor) {
        cursors.elementCursor.setElementCursor(element, cursor);
      }
    };

    this.renderAnnotation = (enabledElement, svgDrawingHelper) => {
      const renderStatus = baseRenderAnnotation(enabledElement, svgDrawingHelper);
      const { viewport } = enabledElement;
      const { element } = viewport;
      let annotations = annotation.state.getAnnotations(this.getToolName(), element);

      if (!annotations?.length) {
        return renderStatus;
      }

      annotations = this.filterInteractableAnnotationsForElement(element, annotations);

      if (!annotations?.length) {
        return renderStatus;
      }

      const styleSpecifier = {
        toolGroupId: this.toolGroupId,
        toolName: this.getToolName(),
        viewportId: enabledElement.viewport.id,
      };

      for (let i = 0; i < annotations.length; i++) {
        const currentAnnotation = annotations[i];
        const { data, annotationUID } = currentAnnotation;

        if (!data?.handles?.points || data.handles.points.length < 4) {
          continue;
        }

        this._ensureRotationHandle(currentAnnotation, viewport);

        styleSpecifier.annotationUID = annotationUID;
        const { color, lineWidth } = this.getAnnotationStyle({
          annotation: currentAnnotation,
          styleSpecifier,
        });

        const handleCanvasPoints = data.handles.points
          .slice(0, 4)
          .map(point => viewport.worldToCanvas(point));

        drawing.drawHandles(
          svgDrawingHelper,
          annotationUID,
          'resize',
          handleCanvasPoints,
          {
            color,
            lineWidth,
          }
        );

        const rotationHandle = data.handles.points[ROTATION_HANDLE_INDEX];
        if (!rotationHandle) {
          continue;
        }

        const rotationHandleCanvas = viewport.worldToCanvas(rotationHandle);
        drawing.drawHandles(
          svgDrawingHelper,
          annotationUID,
          'rotation',
          [rotationHandleCanvas],
          {
            color,
            lineWidth,
          }
        );
      }

      return renderStatus;
    };
  }

  _dragRotationHandle(evt) {
    const eventDetail = evt.detail;
    const { element, currentPoints } = eventDetail;
    const { viewport } = getEnabledElement(element);
    const { annotation } = this.editData;
    const { points } = annotation.data.handles;

    if (!this.editData.rotationData) {
      const startPointsCanvas = points.slice(0, 4).map(point => viewport.worldToCanvas(point));
      const centerCanvas = this._getCenterCanvas(startPointsCanvas);
      const rotationHandleCanvas = this._getRotationHandleCanvasFromCanvasPoints(
        startPointsCanvas,
        centerCanvas
      );

      this.editData.rotationData = {
        startPointsCanvas,
        centerCanvas,
        rotationHandleCanvas,
      };
    }

    const { startPointsCanvas, centerCanvas, rotationHandleCanvas } =
      this.editData.rotationData;
    const currentCanvas = currentPoints.canvas;

    const startAngle = Math.atan2(
      rotationHandleCanvas[1] - centerCanvas[1],
      rotationHandleCanvas[0] - centerCanvas[0]
    );
    const currentAngle = Math.atan2(
      currentCanvas[1] - centerCanvas[1],
      currentCanvas[0] - centerCanvas[0]
    );

    const deltaAngle = currentAngle - startAngle;

    for (let i = 0; i < 4; i++) {
      const rotatedCanvas = this._rotateCanvasPoint(startPointsCanvas[i], centerCanvas, deltaAngle);
      points[i] = viewport.canvasToWorld(rotatedCanvas);
    }

    annotation.invalidated = true;
  }

  _dragResizeHandle(evt) {
    const eventDetail = evt.detail;
    const { currentPoints } = eventDetail;
    const { annotation, handleIndex } = this.editData;
    const { points } = annotation.data.handles;

    const fixedIndex = this._getOppositeHandleIndex(handleIndex);
    const fixedPoint = points[fixedIndex];
    const movingPoint = currentPoints.world;

    const xAxis = this._normalizeVector([
      points[1][0] - points[0][0],
      points[1][1] - points[0][1],
      points[1][2] - points[0][2],
    ]);
    const yAxis = this._normalizeVector([
      points[2][0] - points[0][0],
      points[2][1] - points[0][1],
      points[2][2] - points[0][2],
    ]);

    const delta = [
      movingPoint[0] - fixedPoint[0],
      movingPoint[1] - fixedPoint[1],
      movingPoint[2] - fixedPoint[2],
    ];

    const widthSigned = this._dot(delta, xAxis);
    const heightSigned = this._dot(delta, yAxis);

    const center = [
      fixedPoint[0] + xAxis[0] * (widthSigned / 2) + yAxis[0] * (heightSigned / 2),
      fixedPoint[1] + xAxis[1] * (widthSigned / 2) + yAxis[1] * (heightSigned / 2),
      fixedPoint[2] + xAxis[2] * (widthSigned / 2) + yAxis[2] * (heightSigned / 2),
    ];

    const halfWidth = Math.abs(widthSigned / 2);
    const halfHeight = Math.abs(heightSigned / 2);

    points[0] = this._addVectors(
      center,
      this._addVectors(this._scaleVector(xAxis, -halfWidth), this._scaleVector(yAxis, -halfHeight))
    );
    points[1] = this._addVectors(
      center,
      this._addVectors(this._scaleVector(xAxis, halfWidth), this._scaleVector(yAxis, -halfHeight))
    );
    points[2] = this._addVectors(
      center,
      this._addVectors(this._scaleVector(xAxis, -halfWidth), this._scaleVector(yAxis, halfHeight))
    );
    points[3] = this._addVectors(
      center,
      this._addVectors(this._scaleVector(xAxis, halfWidth), this._scaleVector(yAxis, halfHeight))
    );

    annotation.invalidated = true;
  }

  _getAnnotationNearPoint(element, canvasCoords, proximity = HANDLE_PROXIMITY) {
    let annotations = annotation.state.getAnnotations(this.getToolName(), element);

    if (!annotations?.length) {
      return null;
    }

    annotations = this.filterInteractableAnnotationsForElement(element, annotations);

    for (const currentAnnotation of annotations) {
      const handleNear = this.getHandleNearImagePoint(
        element,
        currentAnnotation,
        canvasCoords,
        proximity
      );

      if (handleNear) {
        return currentAnnotation;
      }

      const toolNear = this.isPointNearTool(element, currentAnnotation, canvasCoords, proximity, 'mouse');

      if (toolNear) {
        return currentAnnotation;
      }
    }

    return null;
  }

  _ensureRotationHandle(annotation, viewport) {
    const { points } = annotation.data.handles;

    if (!points || points.length < 4) {
      return;
    }

    const rotationHandle = this._getRotationHandleWorld(viewport, points);
    points[ROTATION_HANDLE_INDEX] = rotationHandle;
  }

  _getRotationHandleWorld(viewport, points) {
    const rotationHandleCanvas = this._getRotationHandleCanvas(viewport, points);
    return viewport.canvasToWorld(rotationHandleCanvas);
  }

  _getRotationHandleCanvas(viewport, points) {
    const bottomLeftCanvas = viewport.worldToCanvas(points[0]);
    const topLeftCanvas = viewport.worldToCanvas(points[2]);
    const topRightCanvas = viewport.worldToCanvas(points[3]);
    const centerCanvas = [
      (bottomLeftCanvas[0] + topRightCanvas[0]) / 2,
      (bottomLeftCanvas[1] + topRightCanvas[1]) / 2,
    ];
    return this._getRotationHandleCanvasFromCanvasPoints(
      [bottomLeftCanvas, viewport.worldToCanvas(points[1]), topLeftCanvas, topRightCanvas],
      centerCanvas
    );
  }

  _getRotationHandleCanvasFromCanvasPoints(pointsCanvas, centerCanvas) {
    const bottomRight = pointsCanvas[1];
    const topRight = pointsCanvas[3];
    const rightMid = [
      (bottomRight[0] + topRight[0]) / 2,
      (bottomRight[1] + topRight[1]) / 2,
    ];
    const direction = [rightMid[0] - centerCanvas[0], rightMid[1] - centerCanvas[1]];
    const length = Math.hypot(direction[0], direction[1]) || 1;
    const unitDirection = [direction[0] / length, direction[1] / length];
    return [
      rightMid[0] + unitDirection[0] * this.rotationHandleOffset,
      rightMid[1] + unitDirection[1] * this.rotationHandleOffset,
    ];
  }

  _getCenterCanvas(pointsCanvas) {
    const bottomLeft = pointsCanvas[0];
    const topRight = pointsCanvas[3];
    return [(bottomLeft[0] + topRight[0]) / 2, (bottomLeft[1] + topRight[1]) / 2];
  }

  _rotateCanvasPoint(point, center, angle) {
    const translatedX = point[0] - center[0];
    const translatedY = point[1] - center[1];
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    return [
      translatedX * cosAngle - translatedY * sinAngle + center[0],
      translatedX * sinAngle + translatedY * cosAngle + center[1],
    ];
  }

  _getOppositeHandleIndex(handleIndex) {
    if (handleIndex === 0) {
      return 3;
    }
    if (handleIndex === 1) {
      return 2;
    }
    if (handleIndex === 2) {
      return 1;
    }
    return 0;
  }

  _normalizeVector(vector) {
    const length = Math.hypot(vector[0], vector[1], vector[2]);
    if (!length) {
      return [1, 0, 0];
    }
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  }

  _dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  _scaleVector(vector, scale) {
    return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
  }

  _addVectors(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  _isPointInsideAnnotation(annotation, viewport, canvasPoint) {
    const points = annotation.data?.handles?.points;
    if (!points || points.length < 4) {
      return false;
    }

    const canvasPoints = [
      viewport.worldToCanvas(points[0]),
      viewport.worldToCanvas(points[1]),
      viewport.worldToCanvas(points[3]),
      viewport.worldToCanvas(points[2]),
    ];

    return this._isPointInsideConvexPolygon(canvasPoint, canvasPoints);
  }

  _isPointInsideConvexPolygon(point, polygon) {
    let sign = 0;

    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);

      if (cross === 0) {
        continue;
      }

      const crossSign = Math.sign(cross);
      if (sign === 0) {
        sign = crossSign;
      } else if (sign !== crossSign) {
        return false;
      }
    }

    return true;
  }

  _getResizeCursorForHandle(annotation, viewport, handleIndex) {
    const points = annotation.data?.handles?.points;
    if (!points || points.length < 4) {
      return 'nwse-resize';
    }

    const handleWorld = points[handleIndex];
    if (!handleWorld) {
      return 'nwse-resize';
    }

    const centerWorld = [
      (points[0][0] + points[3][0]) / 2,
      (points[0][1] + points[3][1]) / 2,
      (points[0][2] + points[3][2]) / 2,
    ];

    const handleCanvas = viewport.worldToCanvas(handleWorld);
    const centerCanvas = viewport.worldToCanvas(centerWorld);
    const angle = (Math.atan2(handleCanvas[1] - centerCanvas[1], handleCanvas[0] - centerCanvas[0]) * 180) / Math.PI;
    const normalized = (angle + 360) % 360;

    if ((normalized >= 0 && normalized < 90) || (normalized >= 180 && normalized < 270)) {
      return 'nwse-resize';
    }

    return 'nesw-resize';
  }
}

export default RotatableRectangleROITool;
