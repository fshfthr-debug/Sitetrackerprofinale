import React from 'react';

// Icon-only cut of the SiteTracker Pro mark: the shield (pin, towers, road and
// gold frame) with the wordmark ribbon removed, so it stays legible in the
// command bar and as the favicon. The full lockup lives in logo-mark.jsx.
export default function LogoIcon({ className = '' }) {
  return (
    <img
      className={className}
      src={`${process.env.PUBLIC_URL}/logo-icon.png`}
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  );
}
