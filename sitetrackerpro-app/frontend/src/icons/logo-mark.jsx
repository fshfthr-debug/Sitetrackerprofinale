import React from 'react';

// The supplied SiteTracker Pro shield, mastered to a transparent PNG in public/.
// Rendered as an image rather than an inline SVG so the artwork stays exactly as
// drawn: navy shield, gold frame and the SiteTracker Pro banner.
export default function LogoMark({ className = '' }) {
  return (
    <img
      className={className}
      src={`${process.env.PUBLIC_URL}/logo-mark.png`}
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  );
}
