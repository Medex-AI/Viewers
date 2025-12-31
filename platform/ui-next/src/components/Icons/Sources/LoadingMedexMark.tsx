import React from 'react';
import type { IconProps } from '../types';

/**
 * MedEx Loading Icon - Orange-themed animated spinner
 * Displays a rotating medical cross icon with MedEx branding
 */
export const LoadingMedexMark = (props: IconProps) => (
  <svg
    width="64"
    height="64"
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    className="animate-spin"
    {...props}
  >
    <defs>
      <linearGradient
        id="medex-gradient"
        x1="0%"
        y1="0%"
        x2="100%"
        y2="100%"
      >
        <stop
          offset="0%"
          style={{ stopColor: '#F47620', stopOpacity: 1 }}
        />
        <stop
          offset="100%"
          style={{ stopColor: '#FF9A56', stopOpacity: 1 }}
        />
      </linearGradient>
    </defs>

    {/* Outer ring with gradient */}
    <circle
      cx="32"
      cy="32"
      r="28"
      fill="none"
      stroke="url(#medex-gradient)"
      strokeWidth="3"
      strokeLinecap="round"
      strokeDasharray="140 44"
      opacity="0.8"
    />

    {/* Medical cross symbol in center */}
    <g
      fill="#F47620"
      transform="translate(32, 32)"
    >
      {/* Vertical bar */}
      <rect
        x="-3"
        y="-12"
        width="6"
        height="24"
        rx="2"
      />
      {/* Horizontal bar */}
      <rect
        x="-12"
        y="-3"
        width="24"
        height="6"
        rx="2"
      />
      {/* Center circle for emphasis */}
      <circle
        cx="0"
        cy="0"
        r="4"
        fill="#FF9A56"
      />
    </g>

    {/* Inner accent circles */}
    <circle
      cx="32"
      cy="10"
      r="2"
      fill="#F47620"
    />
    <circle
      cx="54"
      cy="32"
      r="2"
      fill="#F47620"
    />
    <circle
      cx="32"
      cy="54"
      r="2"
      fill="#FF9A56"
    />
    <circle
      cx="10"
      cy="32"
      r="2"
      fill="#FF9A56"
    />
  </svg>
);

export default LoadingMedexMark;
