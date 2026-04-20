export default {
  measurementsContextMenu: {
    inheritsFrom: 'ohif.contextMenu',
    menus: [
      // Get the items from the UI Customization for the menu name (and have a custom name)
      {
        id: 'forExistingMeasurement',
        selector: ({ nearbyToolData }) =>
          !!nearbyToolData && nearbyToolData?.metadata?.toolName !== 'ManualContour',
        items: [
          {
            label: 'Delete annotation',
            commands: 'removeMeasurement',
          },
          {
            label: 'Add Label',
            commands: 'setMeasurementLabel',
          },
        ],
      },
    ],
  },
  contourContextMenu: {
    inheritsFrom: 'ohif.contextMenu',
    menus: [
      {
        id: 'forContourAnnotation',
        selector: ({ nearbyToolData }) =>
          !!nearbyToolData &&
          ['ManualContour', 'MaskContour'].includes(nearbyToolData?.metadata?.toolName),
        items: [
          {
            label: 'Delete contour',
            commands: 'removeMeasurement',
          },
          {
            label: 'Change class',
            selector: ({ nearbyToolData }) => nearbyToolData?.metadata?.toolName === 'ManualContour',
            commands: 'showManualContourLabelMenu',
          },
        ],
      },
    ],
  },
};
