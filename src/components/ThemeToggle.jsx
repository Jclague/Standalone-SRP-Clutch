import React, { useEffect, useState } from 'react';
import './ThemeToggle.css';

export default function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('microclutch-theme');
    if (saved) {
      setIsDark(saved === 'dark');
      document.documentElement.setAttribute('data-theme', saved);
    } else {
      setIsDark(false);
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }, []);

  const toggle = () => {
    const newTheme = !isDark ? 'dark' : 'light';
    setIsDark(!isDark);
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('microclutch-theme', newTheme);
  };

  return (
    <button 
      className={`theme-toggle ${isDark ? 'dark' : 'light'}`} 
      onClick={toggle}
      aria-label="Toggle theme"
    >
      <i className={`fa-solid ${isDark ? 'fa-moon' : 'fa-sun'}`}></i>
    </button>
  );
}
