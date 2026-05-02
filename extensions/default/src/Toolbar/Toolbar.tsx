import React from 'react';
import { useToolbar } from '@ohif/core';

export function Toolbar({ servicesManager, buttonSection = 'primary' }) {
  const { toolbarButtons, onInteraction } = useToolbar({
    servicesManager,
    buttonSection,
  });

  if (!toolbarButtons.length) {
    return null;
  }

  return (
    <div className="flex items-center gap-[4px]">
      {toolbarButtons?.map(toolDef => {
        if (!toolDef) {
          return null;
        }

        const { id, Component, componentProps } = toolDef;
        const tool = (
          <Component
            key={id}
            id={id}
            onInteraction={onInteraction}
            servicesManager={servicesManager}
            {...componentProps}
          />
        );

        return (
          <div key={id} className="flex h-[40px] items-center">
            {tool}
          </div>
        );
      })}
    </div>
  );
}
