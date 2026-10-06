import React, { useState } from 'react';
import Navbar from './components/Navbar';
import WebUSBPage from './components/WebUSBPage';
import ProjectsPage from './components/ProjectsPage';
import ThemeToggle from './components/ThemeToggle';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

function App() {
  const [activePage, setActivePage] = useState(0);

  return (
    <div className="app-container">
      <Navbar 
        activePage={activePage} 
        onPageChange={setActivePage} 
      />
      <div className="content-panel">
        <ErrorBoundary>
          <div className={`page ${activePage === 0 ? 'active' : ''}`}>
            <WebUSBPage />
          </div>
          <div className={`page ${activePage === 1 ? 'active' : ''}`}>
            <ProjectsPage />
          </div>
        </ErrorBoundary>
      </div>
      <ThemeToggle />
    </div>
  );
}

export default App;
