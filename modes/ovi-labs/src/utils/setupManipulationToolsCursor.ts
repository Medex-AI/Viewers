import { eventTarget } from '@cornerstonejs/core';
import { Enums, ToolGroupManager, cursors } from '@cornerstonejs/tools';

const TOOL_GROUP_ID = 'default';
const MANIPULATION_TOOLS = ['Zoom', 'Pan', 'WindowLevel'];
const ANNOTATION_TOOLS = [
  'Length',
  'Bidirectional',
  'Probe',
  'EllipticalROI',
  'CircleROI',
  'RectangleROI',
  'RotatableRectangleROI',
  'ManualContour',
  'CalibrationLine',
];

/**
 * Sets up cursor behavior for all tools
 * - Manipulation tools (Zoom, Pan, WindowLevel): default arrow cursor
 * - Annotation tools: crosshair cursor
 */
export default function setupManipulationToolsCursor() {
  const setToolCursor = () => {
    const toolGroup = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!toolGroup) {
      return;
    }

    // Get the active primary tool
    const activeTool = toolGroup.getActivePrimaryMouseButtonTool?.();
    if (!activeTool) {
      return;
    }

    const toolName = activeTool.toolName;
    let cursorType = 'default'; // Default to arrow cursor

    // Set cursor based on tool type
    if (ANNOTATION_TOOLS.includes(toolName)) {
      cursorType = 'crosshair';
    } else if (MANIPULATION_TOOLS.includes(toolName)) {
      cursorType = 'default';
    }

    // Apply cursor to all viewport elements
    const viewports = document.querySelectorAll('[data-viewport-uid]');
    viewports.forEach(viewport => {
      const cursor = cursors.MouseCursor.getDefinedCursor(cursorType);
      if (cursor && viewport) {
        cursors.elementCursor.setElementCursor(viewport as HTMLElement, cursor);
      }
    });
  };

  const onToolActivated = evt => {
    const { toolGroupId } = evt.detail || {};

    if (toolGroupId === TOOL_GROUP_ID) {
      setToolCursor();
    }
  };

  const onMouseMove = evt => {
    const { element } = evt.detail || {};
    if (!element) {
      return;
    }

    const toolGroup = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!toolGroup) {
      return;
    }

    const activeTool = toolGroup.getActivePrimaryMouseButtonTool?.();
    if (!activeTool) {
      return;
    }

    const toolName = activeTool.toolName;

    // Only set cursor for annotation tools (not manipulation tools, they handle their own)
    if (ANNOTATION_TOOLS.includes(toolName)) {
      const cursor = cursors.MouseCursor.getDefinedCursor('crosshair');
      if (cursor) {
        cursors.elementCursor.setElementCursor(element, cursor);
      }
    } else if (MANIPULATION_TOOLS.includes(toolName)) {
      const cursor = cursors.MouseCursor.getDefinedCursor('default');
      if (cursor) {
        cursors.elementCursor.setElementCursor(element, cursor);
      }
    }
  };

  eventTarget.addEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
  eventTarget.addEventListener(Enums.Events.MOUSE_MOVE, onMouseMove);

  // Set initial cursor when mode enters
  setTimeout(setToolCursor, 100);

  return () => {
    eventTarget.removeEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
    eventTarget.removeEventListener(Enums.Events.MOUSE_MOVE, onMouseMove);
  };
}
