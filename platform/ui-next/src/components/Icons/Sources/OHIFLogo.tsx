import React from 'react';
import type { IconProps } from '../types';

export const OHIFLogo = (props: IconProps) => (
  <div
    style={{
      color: '#FFFFFF',
      fontSize: '16px',
      fontWeight: 'bold',
      fontFamily: 'Arial, sans-serif',
      display: 'flex',
      alignItems: 'center',
      height: '28px',
      ...props.style
    }}
    {...props}
  >
    MedEx Image Viewer
  </div>
);

export default OHIFLogo;
