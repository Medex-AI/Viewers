import { Types } from '@ohif/core';
import { id } from './id';
import getPanelModule from './getPanelModule';
import getCommandsModule from './getCommandsModule';
import getToolbarModule from './getToolbarModule';

/**
 * Ovi Labs extension for uterus motion analysis.
 * Provides analysis panel modules for ROI viewing, FFT analysis,
 * kymograph visualization, and temporal measurements.
 */
const oviLabsExtension: Types.Extensions.Extension = {
  /**
   * Only required property. Should be a unique value across all extensions.
   */
  id,

  /**
   * Panel modules for analysis workflows
   */
  getPanelModule,

  /**
   * Commands module for global actions (e.g., open preferences)
   */
  getCommandsModule,

  /**
   * Toolbar module for global preferences button
   */
  getToolbarModule,
};

export default oviLabsExtension;
