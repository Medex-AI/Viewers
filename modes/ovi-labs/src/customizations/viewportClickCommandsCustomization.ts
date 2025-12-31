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
          // Only allow context menu for specific tools (ManualContour uses its own label menu)
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
