import React from 'react';

const OviLabLogo = () => (
  <a
    target="_self"
    rel="noopener noreferrer"
    href="/"
    className="flex items-center"
  >
    <img
      src="./assets/images/medex-logo.svg"
      className="h-8 w-auto dark-theme-logo"
      alt="Ovi Lab"
    />
    <span className="ml-2 text-xl font-semibold text-orange-500">Ovi Lab Viewer</span>
  </a>
);

export default OviLabLogo;