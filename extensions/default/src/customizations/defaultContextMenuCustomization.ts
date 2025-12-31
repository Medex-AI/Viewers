export default {
  measurementsContextMenu: {
    inheritsFrom: 'ohif.contextMenu',
    menus: [
      // Get the items from the UI Customization for the menu name (and have a custom name)
      {
        id: 'forExistingMeasurement',
        selector: ({ nearbyToolData }) =>
          !!nearbyToolData &&
          nearbyToolData?.metadata?.toolName !== 'RotatableRectangleROI' &&
          nearbyToolData?.metadata?.toolName !== 'ManualContour',
        items: [
          {
            label: 'Delete measurement',
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
};
