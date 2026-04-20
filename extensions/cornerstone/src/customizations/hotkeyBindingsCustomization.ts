import { defaults } from '@ohif/core';

const hotkeyBindings = defaults.hotkeyBindings.map(binding => {
  if (binding.commandName === 'incrementActiveViewport' && binding.label === 'Next Image Viewport') {
    return {
      ...binding,
      keys: ['pagedown'],
    };
  }

  if (binding.commandName === 'decrementActiveViewport' && binding.label === 'Previous Image Viewport') {
    return {
      ...binding,
      keys: ['pageup'],
    };
  }

  if (
    binding.commandName === 'updateViewportDisplaySet' &&
    binding.label === 'Previous Series'
  ) {
    return {
      ...binding,
      keys: ['shift+pageup'],
    };
  }

  if (binding.commandName === 'updateViewportDisplaySet' && binding.label === 'Next Series') {
    return {
      ...binding,
      keys: ['shift+pagedown'],
    };
  }

  return binding;
});

hotkeyBindings.push(
  {
    commandName: 'previousTimeFrame',
    label: 'Previous Time Frame',
    keys: ['left'],
    isEditable: true,
  },
  {
    commandName: 'nextTimeFrame',
    label: 'Next Time Frame',
    keys: ['right'],
    isEditable: true,
  }
);

export default {
  'ohif.hotkeyBindings': hotkeyBindings,
};
