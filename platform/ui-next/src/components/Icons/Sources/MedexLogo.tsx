import React from 'react';

const MedexLogo = () => (
  <a
    target="_self"
    rel="noopener noreferrer"
    href="/"
    className="flex items-center"
  >
    <img
      src="./assets/images/medex-logo.svg"
      className="h-12 w-12 dark-theme-logo"
      alt="MedEx"
    />
    <span className="ml-2 text-xl font-semibold text-orange-500">MedEx Viewer</span>
  </a>
);

export default MedexLogo;