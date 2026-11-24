import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import Popup from './Popup';
import { FEATURE_GUIDES, GUIDE_ORDER } from './featureGuides';

const SEEN_KEY = 'stp.feature-guides.v1';

function readPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
    return {
      seen: stored && typeof stored.seen === 'object' && stored.seen ? stored.seen : {},
      auto: stored && stored.auto === false ? false : true
    };
  } catch (err) {
    return { seen: {}, auto: true };
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(prefs));
  } catch (err) {
    // Private mode or a full quota: the guides still work, they just open every time.
  }
}

// ============================================================================
// The feature pop-up system.
//
// Every screen in the product has a guide entry. The pop-up:
//   • opens automatically the first time a screen is visited (once per browser,
//     and only while "open automatically" is on),
//   • can be opened at any time with the ? button in the top bar or the ?
//     keyboard shortcut,
//   • lets the person step through every feature, or jump to a related screen.
//
// `trigger` is a counter owned by AppShell: incrementing it opens the pop-up.
// ============================================================================
export default function FeatureGuidePopup({ screen, trigger = 0, onNavigate }) {
  const prefsRef = useRef(readPrefs());
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(() => Math.max(0, GUIDE_ORDER.indexOf(screen)));
  const [auto, setAuto] = useState(prefsRef.current.auto);
  const [showIndex, setShowIndex] = useState(false);

  const saveSeen = useCallback((nextScreen) => {
    const prefs = readPrefs();
    prefs.seen[nextScreen] = true;
    prefsRef.current = prefs;
    writePrefs(prefs);
  }, []);

  // Open from the top bar / keyboard shortcut.
  useEffect(() => {
    if (!trigger) return;
    setIndex(Math.max(0, GUIDE_ORDER.indexOf(screen)));
    setShowIndex(false);
    setOpen(true);
  }, [trigger, screen]);

  // First visit to a screen opens its guide once. A short delay lets the screen
  // paint first so the pop-up does not race the data load.
  useEffect(() => {
    if (!screen || !FEATURE_GUIDES[screen]) return undefined;
    const prefs = readPrefs();
    if (!prefs.auto || prefs.seen[screen]) return undefined;
    const timer = setTimeout(() => {
      saveSeen(screen);
      setIndex(Math.max(0, GUIDE_ORDER.indexOf(screen)));
      setOpen(true);
    }, 700);
    return () => clearTimeout(timer);
  }, [screen, saveSeen]);

  const current = useMemo(() => FEATURE_GUIDES[GUIDE_ORDER[index]] || FEATURE_GUIDES.dashboard, [index]);
  const currentId = GUIDE_ORDER[index];
  const isCurrentScreen = currentId === screen;
  const guideCount = GUIDE_ORDER.length;

  const close = useCallback(() => setOpen(false), []);

  const go = (offset) => {
    setIndex((value) => (value + offset + guideCount) % guideCount);
    setShowIndex(false);
  };

  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    const prefs = readPrefs();
    prefs.auto = next;
    writePrefs(prefs);
  };

  const openRelated = (target) => {
    const targetIndex = GUIDE_ORDER.indexOf(target);
    if (targetIndex >= 0) setIndex(targetIndex);
    if (onNavigate && target !== screen) onNavigate(target);
  };

  const markers = [
    { id: 'guide', label: 'Why this screen' },
    { id: 'steps', label: 'How to use it' },
    { id: 'tips', label: 'Watch out for' }
  ];

  return (
    <>
      <Popup
        open={open}
        onClose={close}
        kicker={`Feature guide ${index + 1} of ${guideCount}`}
        title={current.title}
        icon={current.icon || 'panel'}
        size="lg"
        footer={
          <div className="guide-foot">
            <label className="guide-auto">
              <input type="checkbox" checked={auto} onChange={toggleAuto} />
              <span>Open automatically on first visit</span>
            </label>
            <div className="guide-foot-nav">
              <button type="button" className="btn btn-sm" onClick={() => setShowIndex((value) => !value)}>
                <Icon name="layers" size={13} /> All features
              </button>
              <button type="button" className="btn btn-sm" onClick={() => go(-1)} aria-label="Previous feature">
                <Icon name="chevronLeft" size={13} />
              </button>
              <button type="button" className="btn btn-sm" onClick={() => go(1)} aria-label="Next feature">
                Next <Icon name="chevronRight" size={13} />
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={close}>Got it</button>
            </div>
          </div>
        }
      >
        {showIndex ? (
          <div className="guide-index">
            {GUIDE_ORDER.map((id, position) => (
              <button
                key={id}
                type="button"
                className={`guide-index-item${position === index ? ' active' : ''}`}
                onClick={() => { setIndex(position); setShowIndex(false); }}
              >
                <Icon name={FEATURE_GUIDES[id].icon || 'panel'} size={14} />
                <span>
                  <strong>{FEATURE_GUIDES[id].title}</strong>
                  <small>{FEATURE_GUIDES[id].kicker}</small>
                </span>
                {id === screen && <span className="guide-here">here</span>}
              </button>
            ))}
          </div>
        ) : (
          <>
            <p className="guide-summary">{current.summary}</p>

            <div className="guide-markers" aria-hidden="true">
              {markers.map(marker => <span key={marker.id}>{marker.label}</span>)}
            </div>

            <ol className="guide-steps">
              {current.steps.map((step, position) => (
                <li key={step.title}>
                  <span className="guide-step-num">{position + 1}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            {current.tips?.length > 0 && (
              <div className="guide-tips">
                <div className="guide-tips-label"><Icon name="alert" size={12} /> Watch out for</div>
                <ul>
                  {current.tips.map(tip => <li key={tip}>{tip}</li>)}
                </ul>
              </div>
            )}

            {current.related?.length > 0 && (
              <div className="guide-related">
                <span>Related features</span>
                <div>
                  {current.related.map(id => (
                    FEATURE_GUIDES[id] ? (
                      <button key={id} type="button" onClick={() => openRelated(id)}>
                        <Icon name={FEATURE_GUIDES[id].icon || 'panel'} size={12} />
                        {FEATURE_GUIDES[id].title.split(' — ')[0]}
                      </button>
                    ) : null
                  ))}
                </div>
              </div>
            )}

            {!isCurrentScreen && onNavigate && (
              <button
                type="button"
                className="guide-goto"
                onClick={() => { onNavigate(currentId); close(); }}
              >
                Open this feature <Icon name="arrowRight" size={13} />
              </button>
            )}

            <p className="guide-note">
              Guides explain the screen; the server still enforces roles and validates every record.
              Press <kbd>?</kbd> at any time to reopen this guide.
            </p>
          </>
        )}
      </Popup>
    </>
  );
}
