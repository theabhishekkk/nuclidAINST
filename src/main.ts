import './style.css';
import { mountApp } from './ui/app';
import { inject } from '@vercel/analytics';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app mount point.');
mountApp(root);

// Initialize Vercel Web Analytics
inject({ mode: import.meta.env.MODE === 'development' ? 'development' : 'production' });
