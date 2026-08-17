import './style.css';
import { mountApp } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app mount point.');
mountApp(root);
