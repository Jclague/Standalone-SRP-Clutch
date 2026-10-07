import React, { useMemo } from 'react';
import { NOTCHES, hzToPct, pctToHz } from '../utils/pollingRateUtils.js';
import './PollingRateSlider.css';

export default function PollingRateSlider({ value = 1000, onChange, disabled = false }) {
  const currentHz = typeof value === 'number' && value > 0 ? value : 1000;
  const currentPct = useMemo(() => hzToPct(currentHz), [currentHz]);
  const isRedZone = currentHz > 1000;

  const handleSliderChange = (e) => {
    const pct = parseFloat(e.target.value);
    const newHz = pctToHz(pct);
    if (onChange) {
      onChange(newHz);
    }
  };

  const handleNotchClick = (hz) => {
    if (disabled) return;
    if (onChange) {
      onChange(hz);
    }
  };

  return (
    <div className="polling-rate-control">
      <div className="polling-header">
        <div className="polling-title-group">
          <span className="polling-title">Polling Rate</span>
        </div>

        <div className="polling-value-group">
          <span className={`polling-hz-display mono ${isRedZone ? 'val-danger' : ''}`}>
            {currentHz > 4000 ? 'Uncapped' : `${currentHz.toLocaleString()} Hz`}
          </span>
        </div>
      </div>

      <div className="slider-row">
        <div className="polling-track-wrapper">
          <div className="polling-track-inner">
            <div className="polling-track-bg">
              <div 
                className="polling-red-zone" 
                style={{ left: '60%', width: '40%' }}
                title="Pedal Sensor Oversampling Region (> 1000 Hz)"
              />

              <div 
                className="polling-track-fill fill-normal"
                style={{ width: `${Math.min(100, Math.max(0, currentPct))}%` }}
              />
              <div 
                className={`polling-track-fill fill-danger ${isRedZone ? 'active' : ''}`}
                style={{ width: `${Math.min(100, Math.max(0, currentPct))}%` }}
              />
            </div>

            <div className="polling-notches-overlay">
              {NOTCHES.map((notch) => {
                const isPassed = currentPct >= notch.pct;
                const isNotchRed = notch.hz > 1000;
                return (
                  <div 
                    key={notch.hz} 
                    className={`notch-tick-mark ${isPassed ? 'passed' : ''} ${isNotchRed ? 'notch-red' : ''}`}
                    style={{ left: `${notch.pct}%` }}
                  />
                );
              })}
            </div>

            <input 
              type="range"
              min="0"
              max="100"
              step="0.25"
              value={currentPct}
              onChange={handleSliderChange}
              disabled={disabled}
              className={`polling-range-input ${isRedZone ? 'input-red-zone' : ''}`}
              aria-label="Polling rate slider"
            />
          </div>
        </div>

        <div 
          className={`red-warning-container ${isRedZone ? 'visible' : ''}`}
          tabIndex={isRedZone ? 0 : -1}
          role={isRedZone ? "alert" : undefined}
          aria-label="Warning: Polling rate limit"
          aria-hidden={!isRedZone}
        >
          <i className="fa-solid fa-triangle-exclamation red-warning-icon"></i>
          <div className="red-warning-tooltip">
            <div className="tooltip-title">
              <i className="fa-solid fa-circle-info"></i>
              <span>USB Polling Capped at 1,000 Hz</span>
            </div>
            <div className="tooltip-body">
              The computer cannot poll the microcontroller at more than 1,000 Hz. Rates above 1,000 Hz only increase the pedal sensor's internal oversampling rate.
            </div>
          </div>
        </div>
      </div>

      <div className="polling-labels-container">
        <div className="polling-labels-inner">
          {NOTCHES.map((notch) => {
            const isActive = currentHz === notch.hz;
            const isNotchRed = notch.hz > 1000;
            return (
              <button
                key={notch.hz}
                type="button"
                className={`notch-label-btn ${isActive ? 'active' : ''} ${isNotchRed ? 'label-red' : ''}`}
                style={{ left: `${notch.pct}%` }}
                onClick={() => handleNotchClick(notch.hz)}
                disabled={disabled}
                title={notch.isUncapped ? 'Set to Fully Uncapped' : `Set to ${notch.hz} Hz`}
              >
                <span className={`notch-val mono ${notch.isUncapped ? 'red-badge' : ''}`}>{notch.label}</span>
                {notch.badge && <span className="notch-badge">{notch.badge}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
