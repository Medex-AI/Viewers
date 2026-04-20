export default {
  cornerstoneViewportClickCommands: {
    doubleClick: ['toggleOneUp'],
    button1: ['closeContextMenu'],
    button3: [
      {
        commandName: 'showOviLabsContextMenu',
        commandOptions: {
          requireNearbyToolData: true,
        },
      },
    ],
  },
};
