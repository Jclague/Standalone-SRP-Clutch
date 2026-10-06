import React, { useState, useEffect } from 'react';
import Burger from './Burger';
import './Navbar.css';

function NavLink({ text, func, isActive }) {
  return (
    <button 
      onClick={func} 
      className={`bar-item nav-link ${isActive ? "nav-selected" : ""}`}
    >
      {text}
    </button>
  );
}

export default function Navbar({ activePage, onPageChange }) {
  const [navOpen, setNavOpen] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [closeDelay, setCloseDelay] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const navItems = [
    { text: "WebUSB", id: 0 },
    { text: "Projects", id: 1 }
  ];

  useEffect(() => {
    let ticking = false;
    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          setIsScrolled(window.scrollY > 20);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    let resizeTimer;
    const handleResize = () => {
      setIsResizing(true);
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => setIsResizing(false), 250);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  function handleBurgerClick() {
    if (!navOpen) {
      setCloseDelay(false);
    }
    setNavOpen(!navOpen);
  }

  function handleNavSelection(id) {
    const prevSelected = activePage;
    onPageChange(id);

    if (window.innerWidth <= 960 && navOpen) {
      if (prevSelected !== id) {
        setCloseDelay(true);
        setTimeout(() => {
          setNavOpen(false);
        }, 30);
      } else {
        setNavOpen(false);
      }
    }
  }

  return (
    <div>
      <Burger navOpen={navOpen} toggleNav={handleBurgerClick} />

      <div 
        className={`nav-bar ${isScrolled ? "nav-shrunk" : ""} ${navOpen ? "nav-open" : ""} ${closeDelay ? "delayed-close" : ""} ${isResizing ? "no-transitions" : ""}`}
      >
        <div className="nav-left-section">
          <span className="bar-item title">
            <span className={`title-full ${navOpen ? "nav-open" : ""}`}>MicroClutch</span>
          </span>
          <div className="link-container">
            {navItems.map((item) => (
              <NavLink 
                key={item.id}
                text={item.text}
                func={() => handleNavSelection(item.id)}
                isActive={activePage === item.id}
              />
            ))}
          </div>
        </div>
        <div className="nav-right-section">
          <button className="nav-button">Firmware</button>
          <button className="nav-button">GitHub</button>
        </div>  
      </div>
    </div>
  );
}
