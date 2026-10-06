import React from 'react';
import './Burger.css';

export default function Burger({ navOpen, toggleNav }) {
  return (
    <>
      <div id="burger-background" className={navOpen ? 'nav-open' : ''}></div>
      <button id="burger-menu" onClick={toggleNav} aria-label="Toggle navigation">
        <span className={`burger-line ${navOpen ? 'burger-open' : ''}`}></span>
        <span className={`burger-line ${navOpen ? 'burger-open' : ''}`}></span>
        <span className={`burger-line ${navOpen ? 'burger-open' : ''}`}></span>
      </button>
    </>
  );
}
