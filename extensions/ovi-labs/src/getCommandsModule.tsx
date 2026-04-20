import React from 'react';
import ReactDOM from 'react-dom';
import PreferencesPanel from './components/PreferencesPanel';

let preferencesModalRoot: HTMLDivElement | null = null;

const openPreferences = () => {
  // Create modal root if it doesn't exist
  if (!preferencesModalRoot) {
    preferencesModalRoot = document.createElement('div');
    preferencesModalRoot.id = 'ovi-labs-preferences-modal';
    document.body.appendChild(preferencesModalRoot);
  }

  const handleClose = () => {
    if (preferencesModalRoot) {
      ReactDOM.unmountComponentAtNode(preferencesModalRoot);
    }
  };

  ReactDOM.render(
    <PreferencesPanel isOpen={true} onClose={handleClose} />,
    preferencesModalRoot
  );
};

const commandsModule = ({ servicesManager }: any) => {
  return {
    definitions: {
      openOviLabsPreferences: {
        commandFn: () => {
          openPreferences();
        },
        storeContexts: [],
        options: {},
      },
    },
    defaultContext: 'ACTIVE_VIEWPORT::CORNERSTONE',
  };
};

export default commandsModule;
