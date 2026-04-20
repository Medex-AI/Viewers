const toolbarModule = ({ servicesManager, commandsManager }: any) => {
  return [
    {
      name: 'OviLabsPreferences',
      id: 'OviLabsPreferences',
      type: 'ohif.radioGroup',
      props: {
        type: 'tool',
        icon: 'settings',
        label: 'OVI Labs Preferences',
        commands: [
          {
            commandName: 'openOviLabsPreferences',
          },
        ],
      },
    },
  ];
};

export default toolbarModule;
