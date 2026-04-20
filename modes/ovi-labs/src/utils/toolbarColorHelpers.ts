import { getContrastColor } from '../../../../extensions/ovi-labs/src/utils/colorUtils';

export const getToolbarButtonElements = (toolNames: string[]): HTMLElement[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  return toolNames
    .flatMap(toolName => {
      const toolRoot = window.document.querySelector(`[data-tool="${toolName}"]`);
      if (!(toolRoot instanceof HTMLElement)) {
        return [];
      }

      const innerButton = toolRoot.querySelector('button');
      return [innerButton instanceof HTMLElement ? innerButton : toolRoot];
    })
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
};

export const updateToolButtonColor = (
  toolNames: string[],
  color: string,
  isActive: boolean
): void => {
  const foregroundColor = getContrastColor(color);
  const buttonElements = getToolbarButtonElements(toolNames);

  buttonElements.forEach(buttonElement => {
    if (isActive) {
      buttonElement.style.setProperty('border', `2px solid ${color}`, 'important');
      buttonElement.style.setProperty('box-shadow', 'none', 'important');
      buttonElement.style.setProperty('background-color', color, 'important');
      buttonElement.style.setProperty('color', foregroundColor, 'important');
    } else {
      buttonElement.style.removeProperty('border');
      buttonElement.style.removeProperty('box-shadow');
      buttonElement.style.removeProperty('background-color');
      buttonElement.style.removeProperty('color');
    }

    buttonElement.querySelectorAll('svg').forEach((icon: any) => {
      if (isActive) {
        icon.style.setProperty('color', foregroundColor, 'important');
      } else {
        icon.style.removeProperty('color');
      }
    });
  });
};
