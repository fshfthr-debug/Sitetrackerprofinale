import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './design.css';
// Loaded last: the connected-construction theme that re-points the tokens.
import './trimble.css';

const container = document.getElementById('root');
createRoot(container).render(<App />);
