# @ohif/extension-ovi-labs

OHIF extension providing analysis panel modules for the Ovi Labs mode (uterus motion analysis).

## Overview

This extension provides 4 panel modules used by the `@ohif/mode-ovi-labs` mode for analyzing uterine motion from sagittal cine MRI sequences.

## Current Status

**Version:** 3.11.0-beta.11 (stub/placeholder implementation)

All panels are currently placeholder components showing "Coming Soon" messages. This allows the mode to load and the frontend to build successfully while full features are implemented incrementally.

## Panels

### 1. ROI Viewer (`roiViewer`)
- **Icon:** `tab-roi-threshold`
- **Purpose:** Display oriented ROI region preview
- **Future Features:**
  - Show current frame's ROI content
  - Optional segmentation mask overlay
  - Orientation indicator
  - Zoom controls

### 2. FFT Analysis (`fftAnalysis`)
- **Icon:** `tab-linear`
- **Purpose:** Frequency domain analysis
- **Future Features:**
  - Frequency spectrum plot (major/minor axis)
  - Dominant frequency display
  - Motion phase classification (OP/LP/MP)
  - Export plot functionality

### 3. Kymographs (`kymographs`)
- **Icon:** `tab-patient-info`
- **Purpose:** Space-time visualization
- **Future Features:**
  - X-t and Y-t kymograph generation
  - Colormap selection (viridis, plasma, etc.)
  - Axis selection (major/minor)
  - Export kymograph image

### 4. Analysis Plots (`analysisPlots`)
- **Icon:** `tab-studies`
- **Purpose:** Temporal measurements from segmentation
- **Future Features:**
  - Area vs time plot
  - Major/minor axes length vs time
  - Circumference vs time
  - Export plots and CSV data

## Architecture

```
extensions/ovi-labs/
├── package.json              # Extension metadata
├── tsconfig.json             # TypeScript configuration
├── .webpack/
│   ├── webpack.dev.js        # Development build config
│   └── webpack.prod.js       # Production build config
└── src/
    ├── index.tsx             # Extension registration
    ├── id.js                 # Extension ID export
    ├── getPanelModule.tsx    # Panel module registration
    └── panels/               # Panel components
        ├── index.ts
        ├── RoiViewerPanel.tsx
        ├── FftAnalysisPanel.tsx
        ├── KymographsPanel.tsx
        └── AnalysisPlotsPanel.tsx
```

## Usage

This extension is automatically loaded by the `@ohif/mode-ovi-labs` mode. It is not intended to be used standalone or with other modes.

### In Mode Configuration

```typescript
const extensionDependencies = {
  '@ohif/extension-default': '3.11.0-beta.11',
  '@ohif/extension-cornerstone': '3.11.0-beta.11',
  '@ohif/extension-ovi-labs': '3.11.0-beta.11',
  '@ohif/extension-dicom-video': '3.11.0-beta.11',
};
```

### Panel References

```typescript
const oviLabsPanels = {
  roiViewer: '@ohif/extension-ovi-labs.panelModule.roiViewer',
  fftAnalysis: '@ohif/extension-ovi-labs.panelModule.fftAnalysis',
  kymographs: '@ohif/extension-ovi-labs.panelModule.kymographs',
  analysisPlots: '@ohif/extension-ovi-labs.panelModule.analysisPlots',
};
```

## Development

### Build Extension

```bash
cd extensions/ovi-labs
yarn build
```

### Development Mode

```bash
yarn dev
```

### Testing

```bash
yarn test:unit
```

## Next Steps

The following features need to be implemented:

1. **Backend Integration**
   - Connect to Python analysis service (planned for port 8503)
   - Implement API service for segmentation and analysis
   - NIfTI conversion utilities

2. **Panel Components**
   - ROI viewer with orientation display
   - FFT analysis with interactive plots
   - Kymograph generation and visualization
   - Temporal measurement plots

3. **Services**
   - Analysis service (FFT, kymograph generation)
   - ROI state management
   - Backend API communication

4. **Utilities**
   - FFT computation
   - Kymograph generation
   - DICOM temporal utilities
   - NIfTI converter

See the main project `PLAN.md` for detailed implementation roadmap.

## Dependencies

- `@ohif/core` - OHIF core services and types
- `@ohif/ui` - OHIF UI components
- `react` - React framework
- `react-dom` - React DOM rendering

## License

MIT

## Related

- **Mode:** `/modes/ovi-labs` - Ovi Labs mode that uses this extension
- **Backend:** `/plugin/ai-segmentation-service` (planned) - AI segmentation service
- **Plugin:** `/plugin/uterus-analysis` - Original Streamlit prototype being migrated

## Changelog

### v3.11.0-beta.11 (2025-12-24)
- Initial stub implementation
- Created 4 placeholder panel components
- Established extension structure
- Fixed build error for mode dependency
