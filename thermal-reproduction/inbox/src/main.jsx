import React from 'react';
import { createRoot } from 'react-dom/client';
import '@blueprintjs/core/lib/css/blueprint.css';
import '@blueprintjs/icons/lib/css/blueprint-icons.css';
import './style.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
