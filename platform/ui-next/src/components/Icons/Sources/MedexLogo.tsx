import React from 'react';

const getRuntimeProductName = () => {
  if (typeof window === 'undefined') {
    return 'MedEx Studio';
  }

  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isIPadLike =
    /iPad/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const coarsePointer =
    window.matchMedia?.('(pointer: coarse)')?.matches ||
    window.matchMedia?.('(any-pointer: coarse)')?.matches ||
    false;
  const shortSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  const isTabletViewport = shortSide >= 768;
  const isTabletLike = hasTouch && (isIPadLike || coarsePointer || isTabletViewport);

  return isTabletLike ? 'MedEx Draw' : 'MedEx Studio';
};

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
    <span className="ml-2 text-xl font-semibold text-orange-500">
      {getRuntimeProductName()}
    </span>
  </a>
);

export default MedexLogo;
