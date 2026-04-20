import { BrushTool as BaseBrushTool } from '@cornerstonejs/tools';

const getTouchArray = touchList => Array.from(touchList || []);

const isStylusTouch = touch =>
  touch?.touchType === 'stylus' ||
  touch?.touchType === 'pen' ||
  touch?.pointerType === 'pen';

const hasStylusTouch = touchList => getTouchArray(touchList).some(isStylusTouch);

const hasSingleStylusContact = nativeEvent => {
  const activeTouches = getTouchArray(nativeEvent?.touches);
  const changedTouches = getTouchArray(nativeEvent?.changedTouches);
  const allTouches = [...activeTouches, ...changedTouches];

  return allTouches.length > 0 && allTouches.length <= 1 && allTouches.some(isStylusTouch);
};

class StylusAwareBrushTool extends BaseBrushTool {
  static toolName = BaseBrushTool.toolName;

  preTouchStartCallback = evt => {
    if (!hasSingleStylusContact(evt?.detail?.event)) {
      return false;
    }

    this.updateCursor(evt);
    return this.preMouseDownCallback(evt);
  };

  touchDragCallback = evt => {
    if (!hasStylusTouch(evt?.detail?.event?.touches)) {
      return;
    }

    this.updateCursor(evt);
    this._dragCallback(evt);
  };

  touchEndCallback = evt => {
    const nativeEvent = evt?.detail?.event;
    const endedWithStylus =
      hasStylusTouch(nativeEvent?.changedTouches) || hasStylusTouch(nativeEvent?.touches);

    if (!endedWithStylus) {
      return;
    }

    this._endCallback(evt);
  };
}

export default StylusAwareBrushTool;
