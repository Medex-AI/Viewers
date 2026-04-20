function initToolGroups(extensionManager, toolGroupService) {
  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.tools'
  );
  const { toolNames, Enums } = utilityModule.exports;

  const tools = {
    active: [
      { toolName: toolNames.WindowLevel, bindings: [{ mouseButton: Enums.MouseBindings.Primary }] },
      { toolName: toolNames.Pan, bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }] },
      { toolName: toolNames.Zoom, bindings: [{ mouseButton: Enums.MouseBindings.Secondary }] },
      { toolName: toolNames.StackScroll, bindings: [{ mouseButton: Enums.MouseBindings.Wheel }] },
    ],
    passive: [
      { toolName: toolNames.Length },
      { toolName: toolNames.Bidirectional },
      { toolName: toolNames.Probe },
      { toolName: toolNames.DebugProbe },
      {
        toolName: 'CircularBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'FILL_INSIDE_CIRCLE',
        },
      },
      {
        toolName: 'CircularEraser',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'ERASE_INSIDE_CIRCLE',
        },
      },
      { toolName: toolNames.EllipticalROI },
      { toolName: toolNames.CircleROI },
      { toolName: toolNames.RectangleROI },
      { toolName: toolNames.RotatableRectangleROI },
      { toolName: toolNames.ManualContour },
      { toolName: toolNames.MaskContour },
      { toolName: toolNames.CalibrationLine },
    ],
    enabled: [{ toolName: toolNames.ImageOverlayViewer }],
  };

  toolGroupService.createToolGroupAndAddTools('default', tools);
}

export default initToolGroups;
