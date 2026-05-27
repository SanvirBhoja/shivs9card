import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

const globalStyles = document.createElement('style');
globalStyles.textContent = `
  html, body, #root {
    min-height: 100%;
    margin: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
  }
  body {
    background: #0a3a1c;
  }
  * {
    box-sizing: border-box;
  }
  button {
    touch-action: manipulation;
  }
`;
document.head.appendChild(globalStyles);
ReactDOM.createRoot(document.getElementById('root')).render(<App />);