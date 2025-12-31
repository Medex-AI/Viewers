export default {
  cornerstoneViewportClickCommands: {
    doubleClick: ['toggleOneUp'],
    button1: ['closeContextMenu'],
    button3: [
      {
        commandName: 'showCornerstoneContextMenu',
        commandOptions: {
          requireNearbyToolData: true,
          menuId: 'measurementsContextMenu',
          disallowedToolNames: ['ManualContour'],
          // Only allow context menu for specific tools (exclude ManualContour and RotatableRectangleROI)
          allowedSelectedTools: [
            'Length',
            'Bidirectional',
            'EllipticalROI',
            'RectangleROI',
            'CircleROI',
            'CalibrationLine',
            'Probe',
          ],
        },
      },
    ],
  },
};
