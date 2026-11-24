import React, { useEffect, useRef } from 'react';
import Icon from './Icon';

// ============================================================================
// One pop-up shell for the whole product.
//
// Every pop-up in SiteTrackerPro (feature guides, map region records, place
// details) uses this component so they behave the same way: Escape closes,
// a click on the backdrop closes, focus moves into the card, the page behind
// stops scrolling and screen readers hear a labelled modal dialog.
//
// `footer` is optional. `children` is the body. Keep the body scrollable: the
// card never grows past the viewport.
// ============================================================================
export default function Popup({
  open,
  onClose,
  kicker,
  title,
  icon = 'panel',
  size = 'md',
  children,
  footer,
  ariaLabel
}) {
  const cardRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
      // Keep Tab inside the dialog. The pop-ups are short, so a simple loop over
      // the focusable elements in the card is enough.
      if (event.key === 'Tab' && cardRef.current) {
        const focusable = cardRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => closeRef.current?.focus(), 30);

    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="pop-overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={cardRef}
        className={`pop-card pop-${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || title}
      >
        <div className="pop-head">
          <div className="pop-head-icon"><Icon name={icon} size={17} /></div>
          <div className="pop-head-copy">
            {kicker && <div className="pop-kicker">{kicker}</div>}
            <h2>{title}</h2>
          </div>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close pop-up">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="pop-body">{children}</div>

        {footer && <div className="pop-foot">{footer}</div>}
      </div>
    </div>
  );
}
