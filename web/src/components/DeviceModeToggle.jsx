import React from 'react';
import './DeviceModeToggle.css';

/**
 * DeviceModeToggle
 * One wide button containing both options (Joystick and Gamepad),
 * with a horizontal sliding pill that smoothly glides either option into focus.
 *
 * Mode 0 = Joystick (Default, prevents Steam Input conflict)
 * Mode 1 = Gamepad (Compatibility mode)
 */
export default function DeviceModeToggle({ mode = 0, onChange, disabled = false }) {
  const isGamepad = mode === 1;

  const handleToggle = (targetMode) => {
    if (disabled) return;
    if (typeof targetMode === 'number') {
      if (targetMode !== mode && onChange) {
        onChange(targetMode);
      }
    } else {
      if (onChange) {
        onChange(isGamepad ? 0 : 1);
      }
    }
  };

  return (
    <div className={`device-mode-card ${disabled ? 'disabled' : ''}`}>
      <div className="device-mode-header">
        <span className="device-mode-title">
          <i className="fa-solid fa-gamepad"></i>
          <span>USB Device Mode</span>
        </span>
      </div>

      {/* One wide button container containing both options with sliding focus pill */}
      <div 
        className={`device-mode-segmented-toggle ${isGamepad ? 'active-gamepad' : 'active-clutch'} ${disabled ? 'is-disabled' : ''}`}
        onClick={() => handleToggle()}
        role="radiogroup"
        aria-label="USB Device Mode"
      >
        {/* Horizontal sliding pill that switches into focus */}
        <div className="device-mode-glider" aria-hidden="true" />

        <button
          type="button"
          className={`device-mode-btn ${!isGamepad ? 'focused' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            handleToggle(0);
          }}
          disabled={disabled}
          role="radio"
          aria-checked={!isGamepad}
          title="Clutch Mode: Automobile Simulation Device (0–65,535). Steam Input will not hijack game controls."
        >
          <svg 
            className="h-pattern-icon" 
            viewBox="0 0 24 24" 
            width="14" 
            height="14" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2.2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 4v16M19 4v16M5 12h14M12 4v16" />
          </svg>
          <span className="mode-label">Clutch</span>
          <span className="mode-sublabel">(Default)</span>
        </button>

        <button
          type="button"
          className={`device-mode-btn ${isGamepad ? 'focused' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            handleToggle(1);
          }}
          disabled={disabled}
          role="radio"
          aria-checked={isGamepad}
          title="Gamepad Mode: Emulates console gamepad thumbstick (-32,767 to 32,767). May be intercepted by Steam Input."
        >
          <i className="fa-solid fa-gamepad"></i>
          <span className="mode-label">Gamepad</span>
          <span className="mode-sublabel">(Compatibility)</span>
        </button>
      </div>

      <div className="device-mode-hint-text">
        {!isGamepad ? (
          <span>
            <i className="fa-solid fa-shield-halved"></i> <strong>Clutch mode:</strong> Reports as a DirectInput Joystick Slider (0–65,535). Natively recognized by Content Manager, Assetto Corsa, and sim racing titles without Steam Input interference.
          </span>
        ) : (
          <span>
            <i className="fa-solid fa-triangle-exclamation"></i> <strong>Gamepad mode:</strong> Emulates a console gamepad thumbstick (-32,767 to 32,767). May be grabbed by Steam Input as an Xbox controller. Use only if a game requires gamepad detection.
          </span>
        )}
      </div>
    </div>
  );
}
