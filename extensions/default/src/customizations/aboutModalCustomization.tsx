import React from 'react';
import { AboutModal } from '@ohif/ui-next';
import detect from 'browser-detect';

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

function AboutModalDefault() {
  const { os, version, name } = detect();
  const browser = `${name[0].toUpperCase()}${name.substr(1)} ${version}`;
  const versionNumber = process.env.VERSION_NUMBER;
  const commitHash = process.env.COMMIT_HASH;

  const [main, beta] = versionNumber.split('-');

  return (
    <AboutModal className="w-[400px]">
      <AboutModal.ProductName>{getRuntimeProductName()}</AboutModal.ProductName>
      <AboutModal.ProductVersion>{main}</AboutModal.ProductVersion>
      {beta && <AboutModal.ProductBeta>{beta}</AboutModal.ProductBeta>}

      <AboutModal.Body>
        <AboutModal.DetailItem
          label="Commit Hash"
          value={commitHash}
        />
        <AboutModal.DetailItem
          label="Current Browser & OS"
          value={`${browser}, ${os}`}
        />
        <AboutModal.SocialItem
          icon="SocialGithub"
          url="OHIF/Viewers"
          text="github.com/OHIF/Viewers"
        />
      </AboutModal.Body>
    </AboutModal>
  );
}

export default {
  'ohif.aboutModal': AboutModalDefault,
};
